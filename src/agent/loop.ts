/**
 * The exploration loop.
 *
 * observe -> reason -> act -> record, repeated, with the loop itself owning
 * everything the model should not have to think about: truncation, retries,
 * duplicate findings, and always leaving artefacts behind even if a run dies
 * halfway.
 */
import path from 'node:path';

import type { Config } from '../config.js';
import { chat, type ChatResult } from '../llm/ollama.js';
import { BrowserSession } from '../mcp/playwright.js';
import { log, colour } from '../util/log.js';
import { RunArtifacts, parseFinding, type StepRecord } from './artifacts.js';
import { unsupportedControlWords, unsupportedTerms } from './evidence.js';
import {
	clickBlockedReason,
	isApplicationUrl,
	isErrorPage,
	navigationBlockedReason,
	resolveNavigation,
} from './navigation.js';
import { cleanNote } from './notes.js';
import { buildStepPrompt, buildSystemPrompt, PROMPT_VERSION, type AgentDecision } from './prompts.js';
import { extractActions, type SnapshotAction } from './snapshot.js';

/** Tool output budget, so one verbose console dump cannot swallow the prompt. */
const MAX_RESULT_CHARS = 2000;
const SNAPSHOT_TOOL = 'browser_snapshot';
/**
 * The console is cheap to read and almost never worth reading twice: the same
 * page reports the same errors. In one measured run the model spent 4 of 15
 * steps re-reading one analytics error. A prompt rule did not stop it, so the
 * loop enforces the budget instead.
 */
const CONSOLE_TOOL = 'browser_console_messages';

export interface ExploreOutcome {
	runDir: string;
	steps: number;
	pages: number;
	findings: number;
	notes: number;
	promptTokens: number;
	outputTokens: number;
	llmMs: number;
	toolMs: number;
	stopReason: 'model-finished' | 'step-limit' | 'error';
}

function truncate(text: string, max: number): string {
	const clean = text.trim();
	if (clean.length <= max) return clean;
	// Factual, not instructive: the model is told what to do about truncation in
	// the system prompt, because everything wrapped as page data has to stay data.
	return `${clean.slice(0, max)}\n\n[...truncated ${clean.length - max} characters of tool output.]`;
}

/** Playwright MCP prefixes snapshots with the page URL and title when it has them. */
function parsePageInfo(snapshot: string): { url: string | null } {
	const match = /^-\s*Page URL:\s*(\S+)/m.exec(snapshot);
	return { url: match?.[1] ?? null };
}

/**
 * Describe tabs other than the current one, when a tool result lists them.
 *
 * This is here because of a false positive that survived several runs. A link
 * that opens in a new tab leaves the current page exactly as it was, which looks
 * identical to a dead link. The agent reported "Link to Elemental Selenium does
 * not navigate" at high severity, twice, while the tab list proving the link had
 * worked sat unread in the same tool result. The evidence was there; it was not
 * being pointed at. Now it is.
 */
export function describeOtherTabs(text: string): string | null {
	const tabs = [...text.matchAll(/^-\s*(\d+):\s*(\(current\)\s*)?\[([^\]]*)\]\(([^)]+)\)/gm)];
	if (tabs.length < 2) return null;
	const others = tabs.filter((match) => match[2] === undefined);
	if (others.length === 0) return null;
	const listed = others.map((match) => `"${match[3]}" at ${match[4]}`);
	return `This browser now has ${tabs.length} open tabs. Tab 0 is the current one. Also open: ${listed.join('; ')}. A click that opens a new tab leaves the current page unchanged, and that is NOT a broken link - the destination did open, in the other tab. The fact that the link works is all you needed from it: carry on exploring the application under test rather than moving into the other tab.`;
}

/**
 * Lenient JSON extraction.
 *
 * Ollama is asked to constrain output to JSON, but a small model can still wrap
 * it in prose or fences, so accept the first object that parses rather than
 * throwing away an otherwise good step.
 */
export function parseDecision(raw: string): AgentDecision {
	const direct = tryParse(raw);
	if (direct) return direct;

	const start = raw.indexOf('{');
	const end = raw.lastIndexOf('}');
	if (start !== -1 && end > start) {
		const sliced = tryParse(raw.slice(start, end + 1));
		if (sliced) return sliced;
	}
	throw new Error(`model did not return parseable JSON: ${raw.slice(0, 200)}`);
}

function tryParse(text: string): AgentDecision | null {
	try {
		const value = JSON.parse(text) as unknown;
		return value && typeof value === 'object' ? (value as AgentDecision) : null;
	} catch {
		return null;
	}
}

interface VettedNote {
	/** The candidate, after a plan has been trimmed off the end. Null when nothing survived. */
	text: string | null;
	/** Whether the candidate is fit for the guide. */
	usable: boolean;
	trimmed: boolean;
	/** Terms the claim named that the browser never returned. */
	unverified: string[];
	/** Why the note was trimmed or dropped, or null when it went in untouched. */
	issue: string | null;
}

/**
 * Check a note the way the guide requires: a plan is not an observation, and a
 * control a claim names either appears in what the browser returned or it does not.
 *
 * Both checks live in one place because there are two doors into app-guide.md - a
 * step that acted, and the closing step that stopped - and only the first one used
 * to be locked. The closing summary is the line a reader meets first.
 */
function vetNote(learned: string, corpus: string): VettedNote {
	if (learned === '') {
		return { text: null, usable: false, trimmed: false, unverified: [], issue: null };
	}

	const cleaned = cleanNote(learned);
	const unverified =
		cleaned.note === null
			? []
			: [
					...unsupportedTerms(cleaned.note, corpus),
					...unsupportedControlWords(cleaned.note, corpus),
				];
	const issue =
		cleaned.note === null
			? 'a plan, not an observation'
			: unverified.length > 0
				? `names ${unverified.join(', ')}, which the browser never returned`
				: cleaned.trimmed
					? 'plan trimmed off the end'
					: null;

	return {
		text: cleaned.note,
		usable: cleaned.note !== null && unverified.length === 0,
		trimmed: cleaned.trimmed,
		unverified,
		issue,
	};
}

export async function explore(config: Config, startedAt: string): Promise<ExploreOutcome> {
	const artifacts = new RunArtifacts(config.runDir, {
		url: config.startUrl,
		model: config.model,
		startedAt,
		promptVersion: PROMPT_VERSION,
	});

	const totals = { promptTokens: 0, outputTokens: 0, llmMs: 0, toolMs: 0 };
	let stopReason: ExploreOutcome['stopReason'] = 'step-limit';
	/** How many times the model has been asked for a decision. */
	let generation = 0;
	let artefactsWritten = false;

	/**
	 * Write everything the run has produced.
	 *
	 * Called from two places on purpose: when the loop ends, and when it throws. A run
	 * that dies at step nine - Ollama stops answering, the browser goes away - still
	 * has nine steps of findings and notes, and throwing them away leaves the run
	 * with nothing to show. The README promises this; it used to be true of the
	 * transcript alone.
	 */
	const writeArtefacts = (): string[] => {
		artefactsWritten = true;
		return artifacts.finalise([
			`model calls: ${generation}`,
			`stop reason: ${stopReason}`,
			`distinct pages reached: ${artifacts.visitedCount}`,
		]);
	};

	log.info(
		`model ${colour.cyan(config.model)}  browser ${config.browser}${config.headless ? ' headless' : ' visible'}`,
	);
	log.info(`artefacts -> ${colour.dim(config.runDir)}`);

	const session = await BrowserSession.start({
		headless: config.headless,
		browser: config.browser,
		extraArgs: config.mcpArgs,
	});

	try {
		const tools = session.availableTools();
		log.dim(`tools exposed to the model: ${tools.map((tool) => tool.name).join(', ')}`);

		const system = buildSystemPrompt(tools, config.startUrl);
		const toolNames = new Set(tools.map((tool) => tool.name));

		// Everything the browser has actually returned this run. "learned" is checked
		// against it, so a note cannot describe a control that was never on the page.
		const evidence: string[] = [];

		log.head('Opening the application');
		const opening = await session.call('browser_navigate', { url: config.startUrl });
		totals.toolMs += opening.ms;
		evidence.push(opening.text);
		if (opening.isError) {
			log.warn(`navigation reported an error: ${opening.text.slice(0, 200)}`);
		}

		let lastAction = `browser_navigate(${JSON.stringify({ url: config.startUrl })})`;
		let lastResult: string | null = truncate(opening.text, MAX_RESULT_CHARS);
		let lastResultLabel = 'The page as loaded';
		/**
		 * What the harness wants done differently, or null.
		 *
		 * Held apart from the page data because the model is promised that anything
		 * wrapped as page data is data and never an instruction. That promise is only
		 * worth something if the instructions arrive somewhere else.
		 */
		let correction: string | null = null;
		let nudgedForBreadth = false;
		// Updated whenever a tool result carries a page URL, so entries in the
		// transcript say where they happened rather than where we started.
		let currentUrl: string | null = parsePageInfo(opening.text).url;
		if (currentUrl !== null) artifacts.addVisitedUrl(currentUrl);
		// Small models stall by re-reading a page they have already read. We detect
		// it from the evidence - identical snapshot text - rather than from the tool
		// name, because re-snapshotting after a real page change is legitimate.
		let lastSnapshotText = '';
		let unchangedSnapshots = 0;
		// Real element refs read off the most recent page view. Playwright returns a
		// fresh snapshot after most actions, so this refreshes itself as we go.
		let actions: SnapshotAction[] = [];
		// Pages whose console has already been read this run.
		const consoleChecked = new Set<string>();

		/**
		 * Write down a step the harness refused.
		 *
		 * Nothing ran, so there is no tool result and no observation - but the step was
		 * spent. Leaving it out of the transcript made the numbers in a report
		 * unexplainable: a run shows nine steps and four of them produced nothing, and
		 * nothing on disk says why.
		 */
		const recordRefusal = (
			stepNumber: number,
			model: ChatResult,
			refusal: { tool: string; args: Record<string, unknown>; thought: string; reason: string },
		): void => {
			artifacts.record({
				step: stepNumber,
				at: new Date().toISOString(),
				url: currentUrl,
				thought: refusal.thought || null,
				tool: refusal.tool,
				args: refusal.args,
				learned: null,
				finding: null,
				noteKept: null,
				noteIssue: null,
				refused: refusal.reason,
				toolMs: 0,
				llmMs: model.stats.totalMs,
				promptTokens: model.stats.promptTokens,
				outputTokens: model.stats.outputTokens,
				resultPreview: '',
				isError: false,
				actions: [],
			});
		};

		/**
		 * Put a note into the guide, and say why it did not go in when it did not.
		 *
		 * Two things can stop a note: it was never an observation, or it is one the run
		 * already established in different words. The first was already reported by
		 * vetNote; the second is decided here, because only the guide knows what it
		 * holds.
		 */
		const keepNote = (vetted: VettedNote): { issue: string | null; duplicate: boolean } => {
			const established =
				vetted.usable && vetted.text !== null ? artifacts.addNote(vetted.text) : false;
			const duplicate = vetted.text !== null && vetted.usable && !established;
			return {
				issue:
					vetted.issue ??
					(duplicate ? 'the same observation was already established in other words' : null),
				duplicate,
			};
		};

		for (let step = 1; step <= config.maxSteps; step += 1) {
			// A correction belongs to the step that earned it, never to the next one.
			correction = null;
			const llm = await chat(
				[
					{ role: 'system', content: system },
					{
						role: 'user',
						content: buildStepPrompt({
							step,
							maxSteps: config.maxSteps,
							currentUrl,
							notes: artifacts.noteList(),
							actions,
							lastAction,
							lastResult,
							lastResultLabel,
							correction,
						}),
					},
				],
				{ baseUrl: config.ollamaUrl, model: config.model, json: true, maxTokens: 700 },
			);
			generation += 1;
			totals.promptTokens += llm.stats.promptTokens;
			totals.outputTokens += llm.stats.outputTokens;
			totals.llmMs += llm.stats.totalMs;

			let decision: AgentDecision;
			try {
				decision = parseDecision(llm.content);
			} catch (error) {
				log.warn(`step ${step}: ${error instanceof Error ? error.message : error}`);
				lastAction = '(model returned unparseable output)';
				lastResult = null;
				lastResultLabel = 'Result';
				correction =
					'Your previous reply was not valid JSON, so no action was taken. Return exactly one JSON object and nothing else.';
				continue;
			}

			const thought = typeof decision.thought === 'string' ? decision.thought.trim() : '';
			const learned = typeof decision.learned === 'string' ? decision.learned.trim() : '';
			const finding = parseFinding(decision.finding);

			if (decision.done === true) {
				// The closing note goes through the same two checks as every other step.
				// It is the part of app-guide.md a reader meets first, and it used to be
				// the one note nothing looked at.
				const closing = vetNote(learned, evidence.join('\n'));
				const closed = keepNote(closing);
				if (finding !== null) artifacts.addFinding(finding);
				if (closing.text !== null && !closing.usable) {
					log.dim(`closing note not kept - ${closing.issue}`);
				}
				if (closed.duplicate) {
					log.dim('closing note already established in other words');
				}
				// Recorded like any other step. Without this, the closing summary sat in
				// app-guide.md and nowhere in the transcript, which is the one question
				// run.jsonl exists to answer: where did this line come from.
				artifacts.record({
					step,
					at: new Date().toISOString(),
					url: currentUrl,
					thought: thought || null,
					tool: null,
					args: null,
					learned: learned || null,
					finding,
					noteKept: closing.text,
					noteIssue: closed.issue,
					refused: null,
					toolMs: 0,
					llmMs: llm.stats.totalMs,
					promptTokens: llm.stats.promptTokens,
					outputTokens: llm.stats.outputTokens,
					resultPreview: '',
					isError: false,
					actions: actions.map((action) => action.label),
				});
				log.step(step, config.maxSteps, `${colour.dim('done')} ${thought}`);
				stopReason = 'model-finished';
				break;
			}

			const tool = typeof decision.tool === 'string' ? decision.tool : '';
			const args = (decision.args ?? {}) as Record<string, unknown>;

			if (!toolNames.has(tool)) {
				log.step(step, config.maxSteps, `${colour.yellow('rejected')} unknown tool "${tool}"`);
				lastAction = `(rejected) ${tool}`;
				lastResult = null;
				const message = `You asked for a tool that does not exist: "${tool}". Available: ${tools
					.map((entry) => entry.name)
					.join(', ')}.`;
				correction = message;
				recordRefusal(step, llm, { tool, args, thought, reason: message });
				continue;
			}

			if (tool === CONSOLE_TOOL && currentUrl !== null && consoleChecked.has(currentUrl)) {
				log.step(step, config.maxSteps, `${colour.yellow('skipped')} console already read on this page`);
				lastAction = `(skipped) ${tool}()`;
				lastResult = null;
				const message =
					'You have already read the console on this page. It reports the same lines every time, so reading it again cannot teach you anything. Do something that changes the page: click an element ref from the snapshot, type into a field, or move to a different part of the application.';
				correction = message;
				recordRefusal(step, llm, { tool, args, thought, reason: message });
				continue;
			}

			if (tool === 'browser_navigate' && typeof args.url === 'string' && currentUrl !== null) {
				const requested = args.url;
				const resolved = resolveNavigation(requested, currentUrl);
				if (resolved !== requested) {
					log.dim(`resolved "${requested}" against the current page -> ${resolved}`);
					args.url = resolved;
				}
			}

			// Where the browser is allowed to go, enforced rather than requested. The
			// loop used to wait until the model had already arrived somewhere else and
			// then spend a paragraph asking it to come back, and one request is all a
			// page needs to aim the agent at a machine that is not on the internet. A
			// click navigates just as surely as browser_navigate does, so the ref's
			// destination is checked with it.
			const clickedRef =
				tool === 'browser_click' && typeof args.target === 'string'
					? actions.find((action) => action.ref === args.target)
					: undefined;
			const destination =
				tool === 'browser_navigate' && typeof args.url === 'string'
					? args.url
					: clickedRef?.url;
			const blocked =
				tool === 'browser_navigate' && typeof args.url === 'string'
					? navigationBlockedReason(args.url, config.startUrl, config.allowedHosts)
					: clickBlockedReason(
							clickedRef,
							config.startUrl,
							config.allowedHosts,
							// A link href is usually a path, so the guard needs the page it
							// would be resolved against.
							currentUrl,
						);

			if (blocked !== null) {
				log.step(step, config.maxSteps, `${colour.yellow('blocked')} ${destination ?? ''}`);
				lastAction = `(blocked) ${tool}(${JSON.stringify(args)})`;
				lastResult = null;
				const message = [
					`The harness refused that action: ${blocked}.`,
					'The browser only reaches the application under test, so nothing was loaded and nothing was learned from it.',
					'Note that the link exists if that is worth recording, then carry on exploring the application itself.',
				].join(' ');
				correction = message;
				recordRefusal(step, llm, { tool, args, thought, reason: message });
				continue;
			}

			const call = await session.call(tool, args);
			totals.toolMs += call.ms;
			if (tool === CONSOLE_TOOL && currentUrl !== null) consoleChecked.add(currentUrl);
			evidence.push(call.text);

			// Any tool result that carries refs is a usable view of the page. When it
			// does not - Playwright sometimes returns a snapshot as a file link rather
			// than inline - the previous refs are stale, so clear them rather than
			// keeping them. A stale ref is worse than no ref: the model will click the
			// wrong element with full confidence. The cost is one explicit snapshot.
			actions = extractActions(call.text);

			const info = parsePageInfo(call.text);
			if (info.url) currentUrl = info.url;
			if (
				currentUrl !== null &&
				!isErrorPage(currentUrl) &&
				isApplicationUrl(currentUrl, config.startUrl)
			) {
				artifacts.addVisitedUrl(currentUrl);
			}

			// A tool call that failed is a mistake in the instruction, or the machine,
			// and never a defect in the application under test. The model cannot tell the
			// difference: one navigation to a malformed URL produced three separate
			// high-severity "findings" about an application that was working fine.
			const usableFinding = call.isError ? null : finding;
			if (call.isError && finding !== null) {
				log.dim(`dropped finding "${finding.title}" - it came from a failed tool call, not from the application`);
			}

			// Notes are checked twice over, in vetNote: a plan is not an observation, and
			// a control the claim names either appears in what the browser returned or it
			// does not. Both quoted names and bare control words are checked, because the
			// model invented a control without quoting it and the quoted-only check let
			// it past.
			const vetted = vetNote(learned, evidence.join('\n'));
			const kept = keepNote(vetted);
			const noteIssue = kept.issue;

			const record: StepRecord = {
				step,
				at: new Date().toISOString(),
				url: currentUrl,
				thought: thought || null,
				tool,
				args,
				learned: learned || null,
				finding: usableFinding,
				// Recorded so the transcript explains itself. Without this, reading
				// run.jsonl cannot tell whether a note was never written, or written and
				// then dropped, which is the first question when the guide looks thin.
				noteKept: vetted.text,
				noteIssue,
				refused: null,
				toolMs: call.ms,
				llmMs: llm.stats.totalMs,
				promptTokens: llm.stats.promptTokens,
				outputTokens: llm.stats.outputTokens,
				resultPreview: truncate(call.text, 400),
				isError: call.isError,
				actions: actions.map((action) => action.label),
			};
			artifacts.record(record);

			if (vetted.trimmed) {
				log.dim(
					vetted.text === null
						? 'dropped a note that described a plan rather than an observation'
						: `trimmed a plan off a note - kept: "${vetted.text}"`,
				);
			}
			if (vetted.unverified.length > 0) {
				log.dim(
					`unverified note - ${vetted.unverified.map((term) => `"${term}"`).join(', ')} appears nowhere in what the browser returned`,
				);
			}
			if (kept.duplicate) {
				log.dim('note already established in other words - the guide keeps the first wording');
			}

			if (usableFinding) artifacts.addFinding(usableFinding);

			const marker = call.isError ? colour.red('failed') : colour.green('ok');
			const refs = actions.length > 0 ? colour.dim(`  ${actions.length} refs`) : '';
			log.step(step, config.maxSteps, `${colour.bold(tool)} ${marker} ${colour.dim(`${call.ms}ms`)}${refs}`);
			if (thought) log.dim(thought);
			if (learned) {
				const mark =
					vetted.text === null
						? colour.yellow('  (a plan, not an observation - not kept)')
						: vetted.unverified.length > 0
							? colour.yellow('  (unverified, not kept)')
							: vetted.trimmed
								? colour.dim(`  (kept: ${vetted.text})`)
								: '';
				log.dim(`learned: ${learned}${mark}`);
			}
			if (usableFinding) log.info(`${colour.yellow(`finding [${usableFinding.severity}]`)} ${usableFinding.title}`);

			// The result of this action is what the next step sees. There is no second
			// "observation" field kept alongside it: the two held the same string, so
			// every step used to pay for its observation twice.
			lastAction = `${tool}(${JSON.stringify(args)})`;
			lastResult = truncate(call.text, MAX_RESULT_CHARS);
			lastResultLabel = `Result of ${tool}`;

			if (tool === SNAPSHOT_TOOL && !call.isError) {
				const text = call.text.trim();
				unchangedSnapshots = text === lastSnapshotText ? unchangedSnapshots + 1 : 0;
				lastSnapshotText = text;
			} else if (tool !== SNAPSHOT_TOOL) {
				unchangedSnapshots = 0;
			}

			// Corrections collect here instead of replacing the observation. All of them
			// are harness text, and the model is promised that the wrapped block is page
			// data; putting instructions inside it would make that promise a lie.
			const notes: string[] = [];

			if (unchangedSnapshots >= 1) {
				log.dim('page unchanged since the last snapshot - pushing the model to act');
				notes.push(
					[
						'You have just read a page that has not changed since your previous snapshot, twice in a row.',
						'A snapshot only reports what is already on screen, so another one cannot tell you anything new.',
						'Your next action must change the state of the application: click an element ref from the snapshot above, type into a field, or navigate to a different URL.',
					].join(' '),
				);
			} else if (
				// Tunnelling is the failure mode the prompt alone could not fix. A run asked
				// to "widen after exploring deeply" spent all 14 of its steps on one page of
				// a twelve-page application, then declared itself finished and reported no
				// defects - true, but only because 11 pages were never opened.
				!nudgedForBreadth &&
				step >= Math.max(3, Math.floor(config.maxSteps / 3)) &&
				artifacts.visitedCount < 3 &&
				step < config.maxSteps - 2
			) {
				nudgedForBreadth = true;
				log.dim(`only ${artifacts.visitedCount} page(s) reached after ${step} steps - pushing the model to widen`);
				notes.push(
					[
						`You have taken ${step} steps and reached only ${artifacts.visitedCount} page(s) of this application.`,
						'A report that covers one page tells a reader nothing about the rest of it.',
						'Go back to the page you started from and open a part of the application you have not seen yet.',
						'If this application genuinely has only one page, move to a different area or control of that page instead.',
					].join(' '),
				);
			}

			// The destination of a new tab is not itself a page of the application, so it
			// is deliberately not added to the coverage list.
			const tabs = describeOtherTabs(call.text);
			if (tabs !== null) notes.push(tabs);

			if (call.isError) {
				notes.push(
					[
						'The tool call you just made failed.',
						'That is a problem with your instruction or with the machine, not a defect in the application under test, so it is never a finding.',
						'Do not report it as one. Work out what was wrong with the action and try a different one.',
					].join('\n'),
				);
			}

			if (vetted.text === null && learned !== '') {
				notes.push(
					[
						`You wrote this in "learned": ${learned}`,
						'That describes what you are about to do rather than what you observed.',
						'"learned" is the only source for the application guide, so a plan in this field is something a reader has to skip past.',
						'Put your next action in "thought", where it belongs, and put what the application does in "learned".',
					].join('\n'),
				);
			}

			if (vetted.unverified.length > 0) {
				notes.push(
					[
						`You wrote this in "learned": ${learned}`,
						`It names ${vetted.unverified.map((term) => `"${term}"`).join(', ')}, which does not appear anywhere in what the browser has returned to you this run.`,
						'You therefore did not observe it. "learned" is the source of the application guide, so a guess in this field becomes a false statement in a document someone else will rely on.',
						'Write only what a tool result showed you, and never name an element you have not seen in the snapshot.',
					].join('\n'),
				);
			}

			// Wandering off the application. The guard above refuses a navigation or a
			// click the snapshot said would leave; this catches the ways that are left,
			// such as a ref whose destination the snapshot never printed.
			if (
				currentUrl !== null &&
				!isErrorPage(currentUrl) &&
				!isApplicationUrl(currentUrl, config.startUrl)
			) {
				log.dim(`off the application under test: ${currentUrl} - pushing the model back`);
				notes.push(
					[
						`You are now at ${currentUrl}, which is not part of the application under test (${config.startUrl}).`,
						'A link led you out of it. What you find here is not about this application, so it does not belong in the findings or the guide.',
						'Note that the link works, go back, and continue exploring the application itself.',
					].join('\n'),
				);
			}

			// Newest last, so reversed here: the checks that matter most - leaving the
			// application, a claim nothing supports - stay at the top where they were.
			correction = notes.length > 0 ? [...notes].reverse().join('\n\n') : null;
		}

		const written = writeArtefacts();

		log.head('Run complete');
		log.info(
			`steps ${artifacts.stepCount}  pages ${artifacts.visitedCount}  findings ${artifacts.findingCount}  notes ${artifacts.noteList().length}  stop: ${stopReason}`,
		);
		log.info(
			`model ${Math.round(totals.llmMs / 1000)}s (${totals.promptTokens} prompt / ${totals.outputTokens} output tokens)  tools ${Math.round(totals.toolMs / 1000)}s`,
		);
		for (const file of written) log.info(`  ${path.join(config.runDir, file)}`);

		return {
			runDir: config.runDir,
			steps: artifacts.stepCount,
			pages: artifacts.visitedCount,
			findings: artifacts.findingCount,
			notes: artifacts.noteList().length,
			promptTokens: totals.promptTokens,
			outputTokens: totals.outputTokens,
			llmMs: totals.llmMs,
			toolMs: totals.toolMs,
			stopReason,
		};
	} catch (error) {
		// The run is over either way, so what it produced is written before the error
		// carries on to the caller. The README promises that artefacts survive a failed
		// run; this is the line that makes that true.
		stopReason = 'error';
		if (!artefactsWritten) {
			const written = writeArtefacts();
			log.head('Run stopped early');
			log.info(
				`steps ${artifacts.stepCount}  pages ${artifacts.visitedCount}  findings ${artifacts.findingCount}  notes ${artifacts.noteList().length}  stop: ${stopReason}`,
			);
			for (const file of written) log.info(`  ${path.join(config.runDir, file)}`);
		}
		throw error;
	} finally {
		await session.close();
	}
}
