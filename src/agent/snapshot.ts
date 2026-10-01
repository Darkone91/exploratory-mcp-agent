/**
 * Reading the accessibility snapshot.
 *
 * A small model spends most of its steps hunting for the element it wants inside
 * a wall of text, and often picks a ref that does not exist. Meanwhile Playwright
 * has already told us every actionable element and its ref. So the harness
 * extracts a shortlist and hands it over, which turns "find the thing" from a
 * reasoning problem into a lookup.
 *
 * The parser is format-tolerant on purpose: it keys off `[ref=...]` rather than
 * assuming a fixed prefix, so a future change to the snapshot renderer degrades
 * this rather than breaking it.
 */

export interface SnapshotAction {
	/** The ref to pass as `target`, e.g. "e12". */
	ref: string;
	/** Human-readable line as it appears in the snapshot, e.g. `link "A/B Testing"`. */
	label: string;
	/** Where a link points, when the snapshot says. */
	url?: string;
}

const REF_PATTERN = /\[ref=([^\]]+)\]/;
const URL_PATTERN = /\/url:\s*(\S+)/;
const ROLE_PATTERN = /^([a-z]+)/;

/**
 * Roles a user can actually do something with.
 *
 * Playwright assigns a ref to *every* node, so without this filter the shortlist
 * fills with `generic` containers and `listitem` wrappers. That is worse than no
 * shortlist at all: it looks authoritative while pointing at things that cannot
 * be acted on.
 */
const INTERACTIVE_ROLES = new Set([
	'link',
	'button',
	'textbox',
	'searchbox',
	'combobox',
	'checkbox',
	'radio',
	'switch',
	'tab',
	'menuitem',
	'menuitemcheckbox',
	'menuitemradio',
	'option',
	'slider',
	'spinbutton',
	'listbox',
	'treeitem',
]);

function roleOf(label: string): string {
	return ROLE_PATTERN.exec(label.trim())?.[1] ?? '';
}

/**
 * The role of an element the shortlist is offering, e.g. "combobox".
 *
 * Exported because the loop makes one decision from it: a click on a select box is
 * not how a select box is operated, and the harness refuses the second one.
 */
export function actionRole(action: SnapshotAction): string {
	return roleOf(action.label);
}

/** Roles that a native `<select>` element carries, which `browser_select_option` operates. */
const SELECT_ROLES = new Set(['combobox', 'listbox']);

/**
 * Whether this element is a select box.
 *
 * A custom dropdown built from divs carries `combobox` too, so this is a hint rather
 * than a fact - which is why the loop only refuses a *repeat* click on one, once the
 * page has been shown not to change. For a real `<select>` the options never enter
 * the page, so the repeat cannot ever learn anything; for a custom one they do, and
 * the repeat is allowed.
 */
export function isSelectBox(action: SnapshotAction | undefined): boolean {
	return action !== undefined && SELECT_ROLES.has(actionRole(action));
}

/**
 * Why this target cannot be acted on right now, or null when it can.
 *
 * The shortlist is the set of things on the page a user could do something with, read
 * off the accessibility tree. Anything else - a container, a heading, a ref from a
 * page the browser has since left - is not a target, and the model reaching for one is
 * not a small mistake: a click on the wrong element does nothing, the page does not
 * change, and a run can spend its whole remaining budget re-reading it.
 *
 * That is not hypothetical. A run typed a username and a password and then clicked
 * `e14`, which was a `generic` container holding the empty error message; the login
 * button was `e15`. The shortlist was empty at that moment for a reason worth
 * understanding: `browser_type` returns only the Playwright call it ran, with no
 * snapshot body, so there were no refs to offer and the model filled the gap from
 * memory of an older page. Playwright resolved the stale ref anyway, the click
 * landed on a div, and the last six steps of the run were spent confirming that
 * nothing had happened.
 *
 * So an empty shortlist is a refusal rather than a licence to guess, and the message
 * says what to do about it.
 */
export function unknownTarget(target: string, actions: SnapshotAction[]): string | null {
	if (actions.length === 0) {
		return [
			`There is nothing you can act on right now, so "${target}" cannot be it.`,
			'Some tools - browser_type among them - return only the action they performed, with no snapshot of the page, so no refs are available at this point in the run.',
			'Take a snapshot, then act on a ref from it.',
		].join(' ');
	}
	if (actions.some((action) => action.ref === target)) return null;

	const menu = actions
		.slice(0, 10)
		.map((action) => `${action.ref} (${action.label})`)
		.join(', ');
	return [
		`"${target}" is not one of the elements you can act on.`,
		`The refs on this page are: ${menu}${actions.length > 10 ? `, and ${actions.length - 10} more` : ''}.`,
		'A container, a heading or a paragraph carries a ref in the page listing but is not something you can act on, and a ref from an earlier page does not survive the browser moving on. Use one of the refs above, or take a fresh snapshot.',
	].join(' ');
}

/** Strip list markers and collapse whitespace so labels read cleanly in a prompt. */
function cleanLabel(text: string): string {
	return text.replace(/^[\s\-*]+/, '').replace(/\s+/g, ' ').trim();
}

/**
 * Extract distinct actionable elements, in document order, up to `max`.
 *
 * Links carry their destination when the snapshot includes it, because the model
 * needs to know where a link goes to decide whether it is part of the application
 * or a trip to GitHub.
 */
export function extractActions(snapshot: string, max = 12): SnapshotAction[] {
	const lines = snapshot.split('\n');
	const actions: SnapshotAction[] = [];
	const seen = new Set<string>();

	for (let index = 0; index < lines.length && actions.length < max; index += 1) {
		const line = lines[index] ?? '';
		const match = REF_PATTERN.exec(line);
		const ref = match?.[1]?.trim();
		if (!match || !ref || seen.has(ref)) continue;

		const label = cleanLabel(line.slice(0, match.index));
		if (label === '') continue;

		// A pointer cursor is direct evidence of clickability, which catches
		// elements whose role is unhelpful - an image that is the inside of a link,
		// for instance.
		const clickable = line.includes('[cursor=pointer]');
		if (!clickable && !INTERACTIVE_ROLES.has(roleOf(label))) continue;

		const url = URL_PATTERN.exec(lines[index + 1] ?? '')?.[1];
		seen.add(ref);
		actions.push(url ? { ref, label, url } : { ref, label });
	}

	return actions;
}

/** Render the shortlist for the prompt. */
export function formatActions(actions: SnapshotAction[]): string {
	return actions.map((action) => `- ${action.ref}  ${action.label}${action.url ? `  ->  ${action.url}` : ''}`).join('\n');
}
