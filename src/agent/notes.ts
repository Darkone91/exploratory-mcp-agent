/**
 * Note hygiene.
 *
 * The `learned` field is the only source for app-guide.md, and roughly half of what
 * a small model puts in it is a plan rather than an observation:
 *
 *   "Navigating back to the homepage to explore another link."
 *   "The homepage contains a link to 'Checkboxes' which I am about to click."
 *
 * Neither of those tells a reader anything about the application. The prompt asks
 * for facts and gives examples of good and bad ones, and the model does it anyway -
 * which by now should surprise nobody, and which is why this is code and not another
 * paragraph of instructions.
 *
 * Most of these claims are not worthless, though. The second one contains a real
 * observation wrapped in a plan, so the plan is cut off rather than the whole note
 * thrown away. The original wording stays in run.jsonl: the transcript is evidence
 * and is never rewritten, only the guide is cleaned.
 */

export interface CleanedNote {
	/** The observed part of the claim, or null if the claim was only a plan. */
	note: string | null;
	/** True when something was removed. */
	trimmed: boolean;
}

/**
 * Where a plan starts. Everything from here on is the agent talking about what it
 * is about to do, and everything before it is what it actually saw.
 *
 * The leading whitespace is deliberate: it keeps the cut from landing in the middle
 * of a word.
 */
const INTENTION_MARKERS: RegExp[] = [
	/\s+and\s+I\s+(?:will|am going to|am about to|need to|should|must|want to|plan to|intend to)\b/i,
	/\s+which\s+I\s+(?:will|am going to|am about to|need to|should|must|plan to)\b/i,
	/\s+that\s+I\s+(?:will|am going to|am about to|need to|should|must|plan to)\b/i,
	/\s+I\s+(?:will|am going to|am about to|need to|should|must|plan to|intend to)\b/i,
	/\s+I(?:'ll|'m about to|'m going to)\b/i,
];

/**
 * A claim that opens with the agent's own action is usually narration.
 *
 * "Navigating back to the homepage to explore another link" has no observed fact in
 * it at all, so there is nothing to trim down to. Imperatives count too - "Take a
 * snapshot to understand the initial layout" is equally a plan.
 *
 * But an opening verb is not enough on its own. "Selecting an option from the
 * dropdown updates the page" is a real observation that happens to start with a
 * gerund, and dropping it would be a silent loss of information, which is the exact
 * failure this file exists to avoid. So an opening action only counts as narration
 * when something else confirms it: a purpose clause, or the agent talking about
 * itself.
 */
const LEADING_ACTION =
	/^(?:now\s+)?(?:navigating|navigated|navigate|taking|took|take|clicking|clicked|click|exploring|explored|explore|opening|opened|open|switching|switched|switch|trying|tried|try|checking|checked|check|inspecting|inspected|inspect|reviewing|reviewed|review|scrolling|scrolled|scroll|typing|typed|type|selecting|selected|select|understanding|understood|understand|looking|looked|look|going|went|go|moving|moved|move|returning|returned|return)\b/i;

/** "to explore", "to understand", "to see" - the agent justifying its next move. */
const PURPOSE_CLAUSE = /\bto\s+(?:explore|understand|see|check|find|verify|investigate|discover|learn|confirm|look)\b/i;

/**
 * Movement, past tense. Always narration - "Navigated back to the homepage" records
 * that the agent moved, not that the application does anything. Past tense is safe
 * to drop unconditionally because an observation about an application is written in
 * the present: "Switching tabs resets the form" survives, "Switched to the new tab"
 * does not.
 */
const MOVEMENT_NARRATION = /^(?:navigated|went|returned|moved|switched|refreshed|reloaded)\b/i;

/** The agent talking about itself. */
const FIRST_PERSON = /\b(?:I|I'm|I'll|my)\b/;

/**
 * Shorter than this and a trimmed fragment is not worth keeping - it reads as a
 * sentence that was cut off, which is worse than no note.
 */
const MIN_FACT_CHARS = 30;

export function cleanNote(claim: string): CleanedNote {
	const text = claim.replace(/\s+/g, ' ').trim();
	if (text === '') return { note: null, trimmed: false };

	const opensWithAnAction = LEADING_ACTION.test(text);
	const isAboutTheAgent = PURPOSE_CLAUSE.test(text) || FIRST_PERSON.test(text);
	if (opensWithAnAction && isAboutTheAgent) return { note: null, trimmed: true };
	if (MOVEMENT_NARRATION.test(text)) return { note: null, trimmed: true };

	let cut = text.length;
	for (const marker of INTENTION_MARKERS) {
		const index = marker.exec(text)?.index;
		if (index !== undefined && index < cut) cut = index;
	}

	if (cut === text.length) return { note: text, trimmed: false };

	const factual = text
		.slice(0, cut)
		.trim()
		.replace(/[,;:]+$/, '')
		// Cutting at a marker leaves the connective that introduced it: "...contains
		// options, but I need to explore other parts" trims to "...contains options,
		// but." A sentence ending on a conjunction reads as truncated, which is exactly
		// the fragment problem this threshold exists to prevent, so the connective goes
		// too.
		.replace(/\s+\b(?:and|but|or|so|then|which|that|because|while|when|as|also)\b$/i, '')
		.replace(/[,;:]+$/, '')
		.trim();

	if (factual.length < MIN_FACT_CHARS) return { note: null, trimmed: true };
	return { note: /[.!?]$/.test(factual) ? factual : `${factual}.`, trimmed: true };
}
