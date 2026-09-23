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
