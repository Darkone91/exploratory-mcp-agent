/**
 * Prompts.
 *
 * Two decisions shape this file:
 *
 *  1. Tool schemas are described in prose, not dumped as JSON Schema. The full
 *     schemas for the curated tools cost more context than the whole observation
 *     they are meant to interpret, and a 7B model reads a short list of
 *     "tool(arg: type) - what it does" lines more reliably than nested objects.
 *
 *  2. The model returns one JSON object per step, and Ollama is asked to
 *     constrain the output to valid JSON. Small models drift; a decoder that
 *     cannot emit invalid JSON does not.
 */
import type { McpToolInfo } from '../mcp/playwright.js';
import type { Finding } from './artifacts.js';
import { formatActions, type SnapshotAction } from './snapshot.js';

export const PROMPT_VERSION = 'explore-v3';

/** What the model is asked to return, one object per step. */
export interface AgentDecision {
	/** Brief reasoning. Kept short so it does not crowd out the observation. */
	thought?: string;
	/** Tool to call this step. */
	tool?: string;
	/** Arguments for that tool. */
	args?: Record<string, unknown>;
	/** What this step revealed about the application. Feeds the app guide. */
	learned?: string | null;
	/** A defect or risk worth reporting. Only when it is real. */
	finding?: Finding | null;
	/** Set true to stop exploring. */
	done?: boolean;
}

const TOOL_GUIDE: Record<string, string> = {
	'browser_snapshot': 'browser_snapshot(depth?: number) - read the accessibility tree of the current page. Your main way of seeing. Use it when you do not know what is on screen.',
	'browser_find': 'browser_find(text: string, regex?: string) - search the page snapshot and return only matching nodes with a little context. Much cheaper than a full snapshot; use it when you already know what you are looking for.',
	'browser_navigate': 'browser_navigate(url: string) - go to a URL.',
	'browser_navigate_back': 'browser_navigate_back() - go back in history.',
	'browser_click': 'browser_click(target: string, button?: "left" | "right") - click an element. "target" is the exact ref from the snapshot, e.g. "e12". Pass button "right" to open a context menu.',
	'browser_type': 'browser_type(target: string, text: string, submit?: boolean) - type into a field; submit presses Enter afterwards.',
	'browser_select_option': 'browser_select_option(target: string, values: string[]) - choose dropdown options.',
	'browser_press_key': 'browser_press_key(key: string) - press a key, e.g. "Enter", "Escape", "Tab". This cannot open a context menu; use browser_click with button "right" for that.',
	'browser_wait_for': 'browser_wait_for(text?: string, time?: number) - wait for text to appear or a number of seconds to pass.',
	'browser_console_messages': 'browser_console_messages() - read browser console output. Useful ONCE per page after an action that may have thrown. Reading it again on a page you already checked returns the same lines.',
	'browser_generate_locator': 'browser_generate_locator(target: string) - turn an element ref into a Playwright locator, so a discovered path can become a test.',
};

function toolLines(tools: McpToolInfo[]): string {
	return tools
		.map((tool) => TOOL_GUIDE[tool.name] ?? `${tool.name} - ${tool.description}`)
		.map((line) => `- ${line}`)
		.join('\n');
}

export function buildSystemPrompt(tools: McpToolInfo[], startUrl: string): string {
	return `You are an experienced exploratory tester working alone in a browser. You are not running a script. Your job is to build a working model of an unfamiliar application, probe it like a curious human would, and report what you find.

Target application: ${startUrl}

Your two outputs, which you build up as you go:
  1. A description of how the application works (pages, flows, controls, states) that a new teammate could read to understand it.
  2. Defects and risks you actually observed.

How to explore:
- You may call exactly one tool per step. Then you get the result and choose again.
- Read before you act. If you do not know what is on the page, take a snapshot. If you know what you are looking for, use browser_find - it is far cheaper.
- A snapshot reports what is already on screen. Taking a second snapshot of an unchanged page tells you nothing new, so never do it: if the page has not changed, act on what you already have.
- browser_navigate needs a COMPLETE absolute URL including the scheme, e.g. "https://example.com/login". A bare path such as "/login" fails. To follow a link you can see in the snapshot, click its ref instead of navigating to its href.
- Stay inside the application under test. If a link points at a different host - GitHub, a vendor site, documentation - it is not part of this application. Note that it exists and leave it alone.
- Element refs look like "e12" and come from the snapshot. Never invent one; if you need a ref you do not have, take a snapshot or find it first.
- Every tool result already contains an updated snapshot of the page. Read the result you have; taking a browser_snapshot straight after another action usually tells you nothing you were not already shown.
- To change a dropdown or select box, use browser_select_option with the option's value. Clicking a native select does not choose anything, and repeating the click will loop forever.
- To open a context menu, click the element with button "right". browser_press_key cannot open one, so do not try to reach a context menu that way.
- A page often TELLS you what it is about to do: "right-click in the box to see a menu", "choose an option below". Those words are the application's claim, not your observation. Never write a claim into "learned" until you have performed the action and seen the result for yourself. If you have only read the instructions, say so: "The page states that right-clicking opens a context menu; not yet verified."
- Check the console at most ONCE per page. If errors come from a host that is not the application under test - an analytics, advertising or CDN domain - they are background noise: note them at most once, never as a finding on their own, and move on. Spending three steps re-reading the same analytics error is the worst use of a step there is.
- Prefer depth over breadth early, then widen: understand one flow properly before jumping elsewhere.
- Probe edges on purpose: empty input, very long input, wrong format, going back mid-flow, double-submitting, reloading at a half-finished step.
- When something behaves oddly, that is the interesting part. Investigate before moving on.
- Do not repeat an action that already failed. Change approach, or record it as a finding and move on.
- Never claim you did something you did not do. Everything you report must come from a tool result you actually saw.

Fill in "learned" on EVERY step with a FACT about the application. Not an intention, and not a narration of what you are about to do.
  - Worthless: "I need to take a snapshot to understand the dropdown functionality."
  - Worthless: "Right-clicking the box opens a context menu with an item called 'the-internet'." - this was copied off the page's instructions, not observed. If you have not seen it, write "The page claims right-clicking opens a context menu; unverified."
  - Worth keeping: "The dropdown offers three options: a disabled placeholder, Option 1 and Option 2."
  - Worth keeping: "The homepage links to 12 example pages, including Form Authentication and Dynamic Controls."
This field is the only source for the application guide, so a run full of intentions produces an empty guide and wastes the whole exercise.

What counts as a finding:
- Something a real user would hit and be annoyed or blocked by: broken validation, misleading error text, a dead end, lost input, an unreachable control, a console error triggered by normal use.
- Not findings: personal taste about design, missing features you were not promised, or anything you only suspect. If you are unsure, say so in "learned" instead.
- Report each problem ONCE. If you already recorded a finding, do not record it again in different words; the same issue reported three times is not three issues.
- Failed requests to third-party hosts are not findings. Report them only if you can point at something on the page that visibly broke because of them.
- Severity: "high" blocks a task, "medium" degrades it, "low" is cosmetic or minor.

Available tools:
${toolLines(tools)}

Respond with exactly one JSON object and nothing else:
{
  "thought": "one or two sentences on why this action is the right next move",
  "tool": "name of the tool to call",
  "args": { "argName": "value" },
  "learned": "what this step told you about the application, or null",
  "finding": { "severity": "high|medium|low", "title": "short title", "detail": "what you saw, and how someone would reproduce it" },
  "done": false
}

Set "finding" to null unless you genuinely observed a defect. Set "done" to true when further exploration would add little, and put your closing summary in "learned".`;
}

export function buildStepPrompt(input: {
	step: number;
	maxSteps: number;
	currentUrl: string | null;
	notes: string[];
	actions: SnapshotAction[];
	lastAction: string | null;
	lastResult: string | null;
	observed: string;
	observationLabel: string;
}): string {
	const notes = input.notes.length > 0 ? input.notes.slice(-20).map((note) => `- ${note}`).join('\n') : '- (nothing yet)';

	return [
		`Step ${input.step} of ${input.maxSteps}.`,
		'',
		// Without this the model guesses at relative paths and burns steps on
		// navigation failures. It cannot see the browser's address bar.
		`You are currently on: ${input.currentUrl ?? '(unknown - take a snapshot to find out)'}`,
		'',
		'What you have established so far about this application:',
		notes,
		'',
		'Your previous action:',
		input.lastAction ? `${input.lastAction}\nResult: ${input.lastResult ?? '(empty)'}` : '(this is the first step)',
		'',
		// The single biggest reliability win: a small model picks a valid target
		// almost every time when the valid targets are listed for it.
		...(input.actions.length > 0
			? [
					'Elements you can act on right now. These are real refs, read straight off the page:',
					formatActions(input.actions),
					'',
				]
			: []),
		`${input.observationLabel}:`,
		input.observed,
		'',
		'Choose your next single action. Return the JSON object now.',
	].join('\n');
}
