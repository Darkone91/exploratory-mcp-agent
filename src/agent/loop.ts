/**
 * The exploration loop.
 *
 * observe -> reason -> act -> record, repeated, with the loop itself owning
 * everything the model should not have to think about: truncation, retries,
 * duplicate findings, and always leaving artefacts behind even if a run dies
 * halfway.
 */
import type { Config } from '../config.js';
import { chat } from '../llm/ollama.js';
import { BrowserSession } from '../mcp/playwright.js';
import { log, colour } from '../util/log.js';
import { RunArtifacts, parseFinding, type StepRecord } from './artifacts.js';
import { unsupportedControlWords, unsupportedTerms } from './evidence.js';
import { cleanNote } from './notes.js';
import { buildStepPrompt, buildSystemPrompt, type AgentDecision } from './prompts.js';
import { extractActions, type SnapshotAction } from './snapshot.js';

/** Snapshot budget. ~6k chars is roughly 1.5k tokens, which measures at ~6s. */
const MAX_SNAPSHOT_CHARS = 6000;
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
	return `${clean.slice(0, max)}\n\n[...truncated ${clean.length - max} characters. Take a fresh snapshot, or use browser_find to look something up instead of reading the whole page.]`;
}

/**
 * Resolve a navigation target against the current page.
 *
 * The prompt has told the model, in every version of this file, that
 * browser_navigate needs a complete absolute URL and that a bare path fails.
 * It used one anyway: a run sent "/abtest", Playwright looked for https://abtest/,
 * DNS failed, and the agent then reported the resulting error page as a
 * high-severity defect in the application. Prompts persuade; this enforces.
 */
function resolveNavigation(target: string, base: string): string {
	if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return target;
	try {
		return new URL(target, base).toString();
	} catch {
		return target;
	}
}

/**
 * Browser error pages are noise in a coverage list - nobody tested anything on
 * chrome-error://chromewebdata/.
 */
function isErrorPage(url: string): boolean {
	return url.startsWith('chrome-error:') || url === 'about:blank' || url.startsWith('data:');
}

/**
 * Whether a URL belongs to the application under test.
 *
 * A run followed a link into a vendor's website and spent the rest of its budget
 * there. Those pages must not count towards coverage either: "this run reached 7
 * pages" is a statement about the application, and a third-party marketing site is
 * not one of its pages.
 */
export function isApplicationUrl(url: string, startUrl: string): boolean {
	try {
		const target = new URL(url);
		const start = new URL(startUrl);
		if (target.origin === start.origin) return true;
		// Sibling subdomains are usually the same product - a login on
		// app.example.com and help on docs.example.com. The leading dot matters:
		// it is what stops notexample.com from matching example.com.
		return (
			target.hostname.endsWith(`.${start.hostname}`) ||
			start.hostname.endsWith(`.${target.hostname}`)
		);
	} catch {
		return false;
	}
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

export async function explore(config: Config, startedAt: string): Promise<ExploreOutcome> {
	const artifacts = new RunArtifacts(config.runDir, {
		url: config.startUrl,
		model: config.model,
		startedAt,
	});

	const totals = { promptTokens: 0, outputTokens: 0, llmMs: 0, toolMs: 0 };
	let stopReason: ExploreOutcome['stopReason'] = 'step-limit';

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

		let lastAction = `browser_navigate({"url":${JSON.stringify(config.startUrl)}})`;
		let lastResult = truncate(opening.text, MAX_RESULT_CHARS);
		let observed = lastResult;
		let observationLabel = 'The page as loaded';
		let generation = 0;
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

		for (let step = 1; step <= config.maxSteps; step += 1) {
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
							observed,
							observationLabel,
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
				lastResult = 'Your previous reply was not valid JSON. Return exactly one JSON object.';
				observed = 'Retry the previous step: reply with a single JSON object only.';
				observationLabel = 'Correction needed';
				continue;
			}

			const thought = typeof decision.thought === 'string' ? decision.thought.trim() : '';
			const learned = typeof decision.learned === 'string' ? decision.learned.trim() : '';
			const finding = parseFinding(decision.finding);

			if (decision.done === true) {
				if (learned !== '') artifacts.addNote(learned);
				log.step(step, config.maxSteps, `${colour.dim('done')} ${thought}`);
				stopReason = 'model-finished';
				break;
			}

			const tool = typeof decision.tool === 'string' ? decision.tool : '';
			const args = (decision.args ?? {}) as Record<string, unknown>;

			if (!toolNames.has(tool)) {
				log.step(step, config.maxSteps, `${colour.yellow('rejected')} unknown tool "${tool}"`);
				lastAction = `(rejected: ${tool})`;
				lastResult = `"${tool}" is not available.`;
				observed = `You asked for a tool that does not exist: "${tool}". Available: ${tools
					.map((entry) => entry.name)
					.join(', ')}.`;
				observationLabel = 'Correction needed';
				continue;
			}

			if (tool === CONSOLE_TOOL && currentUrl !== null && consoleChecked.has(currentUrl)) {
				log.step(step, config.maxSteps, `${colour.yellow('skipped')} console already read on this page`);
				lastAction = `${tool}()`;
				lastResult = '(skipped: the console on this page has already been read this run)';
				observed =
					'You have already read the console on this page. It reports the same lines every time, so reading it again cannot teach you anything. Do something that changes the page: click an element ref from the snapshot, type into a field, or move to a different part of the application.';
				observationLabel = 'Correction needed';
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

			const record: StepRecord = {
				step,
				at: new Date().toISOString(),
				url: currentUrl,
				thought: thought || null,
				tool,
				args,
				learned: learned || null,
				finding: usableFinding,
				toolMs: call.ms,
				llmMs: llm.stats.totalMs,
				promptTokens: llm.stats.promptTokens,
				outputTokens: llm.stats.outputTokens,
				resultPreview: truncate(call.text, 400),
				isError: call.isError,
				actions: actions.map((action) => action.label),
			};
			artifacts.record(record);

			// Notes are checked twice over: a plan is not an observation, and a control the
			// claim names either appears in what the browser returned or it does not.
			// Both quoted names and bare control words are checked, because the model
			// invented a control without quoting it and the quoted-only check let it past.
			const cleaned = learned === '' ? { note: null, trimmed: false } : cleanNote(learned);
			const corpus = evidence.join('\n');
			const unverified =
				cleaned.note === null
					? []
					: [
							...unsupportedTerms(cleaned.note, corpus),
							...unsupportedControlWords(cleaned.note, corpus),
						];

			if (cleaned.trimmed) {
				log.dim(
					cleaned.note === null
						? 'dropped a note that described a plan rather than an observation'
						: `trimmed a plan off a note - kept: "${cleaned.note}"`,
				);
			}
			if (unverified.length > 0) {
				log.dim(
					`unverified note - ${unverified.map((term) => `"${term}"`).join(', ')} appears nowhere in what the browser returned`,
				);
			}
			if (cleaned.note !== null && unverified.length === 0) artifacts.addNote(cleaned.note);

			if (usableFinding) artifacts.addFinding(usableFinding);

			const marker = call.isError ? colour.red('failed') : colour.green('ok');
			const refs = actions.length > 0 ? colour.dim(`  ${actions.length} refs`) : '';
			log.step(step, config.maxSteps, `${colour.bold(tool)} ${marker} ${colour.dim(`${call.ms}ms`)}${refs}`);
			if (thought) log.dim(thought);
			if (learned) {
				const mark =
					cleaned.note === null
						? colour.yellow('  (a plan, not an observation - not kept)')
						: unverified.length > 0
							? colour.yellow('  (unverified, not kept)')
							: cleaned.trimmed
								? colour.dim(`  (kept: ${cleaned.note})`)
								: '';
				log.dim(`learned: ${learned}${mark}`);
			}
			if (usableFinding) log.info(`${colour.yellow(`finding [${usableFinding.severity}]`)} ${usableFinding.title}`);

			// The observation for the next step is the result of this action, unless
			// we need to re-read the page - so we snapshot lazily, only when the model
			// asks for it, and otherwise feed back the raw result.
			lastAction = `${tool}(${JSON.stringify(args)})`;
			lastResult = truncate(call.text, MAX_RESULT_CHARS);
			observed = lastResult;
			observationLabel = `Result of ${tool}`;

			if (tool === SNAPSHOT_TOOL && !call.isError) {
				const text = call.text.trim();
				unchangedSnapshots = text === lastSnapshotText ? unchangedSnapshots + 1 : 0;
				lastSnapshotText = text;
			} else if (tool !== SNAPSHOT_TOOL) {
				unchangedSnapshots = 0;
			}

			if (unchangedSnapshots >= 1) {
				log.dim('page unchanged since the last snapshot - pushing the model to act');
				observed = [
					'You have just read a page that has not changed since your previous snapshot, twice in a row.',
					'A snapshot only reports what is already on screen, so another one cannot tell you anything new.',
					'Your next action must change the state of the application: click an element ref from the snapshot above, type into a field, or navigate to a different URL.',
				].join(' ');
				observationLabel = 'Correction needed';
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
				observed = [
					`You have taken ${step} steps and reached only ${artifacts.visitedCount} page(s) of this application.`,
					'A report that covers one page tells a reader nothing about the rest of it.',
					'Go back to the page you started from and open a part of the application you have not seen yet.',
					'If this application genuinely has only one page, move to a different area or control of that page instead.',
				].join(' ');
				observationLabel = 'Correction needed';
			}

			// Applied last so the tab list survives whichever correction above ran. The
			// destination of a new tab is not itself a page of the application, so it is
			// deliberately not added to the coverage list.
			const tabs = describeOtherTabs(call.text);
			if (tabs !== null) {
				observed = `${tabs}\n\n${observed}`;
				observationLabel = `${observationLabel} (a new tab was opened)`;
			}

			if (call.isError) {
				observed = [
					'The tool call you just made failed.',
					'That is a problem with your instruction or with the machine, not a defect in the application under test, so it is never a finding.',
					'Do not report it as one. Work out what was wrong with the action and try a different one.',
					'',
					observed,
				].join('\n');
				observationLabel = 'Correction needed (your action failed)';
			}

			if (cleaned.note === null && learned !== '') {
				observed = [
					`You wrote this in "learned": ${learned}`,
					'That describes what you are about to do rather than what you observed.',
					'"learned" is the only source for the application guide, so a plan in this field is something a reader has to skip past.',
					'Put your next action in "thought", where it belongs, and put what the application does in "learned".',
					'',
					observed,
				].join('\n');
				observationLabel = 'Correction needed (a plan, not an observation)';
			}

			if (unverified.length > 0) {
				observed = [
					`You wrote this in "learned": ${learned}`,
					`It names ${unverified.map((term) => `"${term}"`).join(', ')}, which does not appear anywhere in what the browser has returned to you this run.`,
					'You therefore did not observe it. "learned" is the source of the application guide, so a guess in this field becomes a false statement in a document someone else will rely on.',
					'Write only what a tool result showed you, and never name an element you have not seen in the snapshot.',
					'',
					observed,
				].join('\n');
				observationLabel = 'Correction needed (unverified claim)';
			}

			// Wandering off the application. Prompt rules have not been enough here either:
			// a run followed a link into the vendor's own site and spent the rest of its
			// budget exploring that instead, while reporting it as if it were the app.
			if (
				currentUrl !== null &&
				!isErrorPage(currentUrl) &&
				!isApplicationUrl(currentUrl, config.startUrl)
			) {
				log.dim(`off the application under test: ${currentUrl} - pushing the model back`);
				observed = [
					`You are now at ${currentUrl}, which is not part of the application under test (${config.startUrl}).`,
					'A link led you out of it. What you find here is not about this application, so it does not belong in the findings or the guide.',
					'Note that the link works, go back, and continue exploring the application itself.',
					'',
					observed,
				].join('\n');
				observationLabel = 'Correction needed (you left the application)';
			}
		}

		const written = artifacts.finalise([
			`model calls: ${generation}`,
			`stop reason: ${stopReason}`,
			`distinct pages reached: ${artifacts.visitedCount}`,
		]);

		log.head('Run complete');
		log.info(
			`steps ${artifacts.stepCount}  pages ${artifacts.visitedCount}  findings ${artifacts.findingCount}  notes ${artifacts.noteList().length}  stop: ${stopReason}`,
		);
		log.info(
			`model ${Math.round(totals.llmMs / 1000)}s (${totals.promptTokens} prompt / ${totals.outputTokens} output tokens)  tools ${Math.round(totals.toolMs / 1000)}s`,
		);
		for (const file of written) log.info(`  ${config.runDir}\\${file}`);

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
	} finally {
		await session.close();
	}
}
