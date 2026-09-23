/**
 * Calibration check for note hygiene.
 *
 * Every "before" string below is copied verbatim from the committed example run, so
 * these are the sentences the model actually produced rather than ones I invented to
 * flatter the parser.
 *
 * There are two failure modes and they pull in opposite directions:
 *   - too timid  -> the guide keeps reading like a narrator telling you what it is
 *                   about to do, which is the problem this exists to fix
 *   - too eager  -> a real observation is trimmed into a fragment or dropped, and
 *                   the guide silently loses information
 *
 * The middle cases are why this is a trim and not a filter: the observation and the
 * plan are in one sentence, and only one of them is worth keeping.
 *
 * Run: npm test
 */
import { cleanNote } from '../src/agent/notes.js';

interface Case {
	before: string;
	/** The exact expected note, or null when there is no observation in the claim. */
	after: string | null;
	kind: 'kept' | 'trimmed' | 'dropped';
}

const CASES: Case[] = [
	// --- real observations: must survive untouched ---------------------------------
	{
		before:
			'The homepage of the application displays a list of links to various example pages and a footer with copyright information.',
		after:
			'The homepage of the application displays a list of links to various example pages and a footer with copyright information.',
		kind: 'kept',
	},
	{
		before: 'The Checkboxes page contains two checkboxes and a paragraph describing the purpose of the page.',
		after: 'The Checkboxes page contains two checkboxes and a paragraph describing the purpose of the page.',
		kind: 'kept',
	},
	{
		before: 'The first checkbox is now checked after clicking it.',
		after: 'The first checkbox is now checked after clicking it.',
		kind: 'kept',
	},
	{
		before: 'The second checkbox is now unchecked after clicking it.',
		after: 'The second checkbox is now unchecked after clicking it.',
		kind: 'kept',
	},

	// --- observation wrapped in a plan: keep the front, cut the back ---------------
	{
		before: "The homepage contains a link to 'A/B Testing' which I will now click to explore the next page.",
		after: "The homepage contains a link to 'A/B Testing'.",
		kind: 'trimmed',
	},
	{
		before: "The homepage contains a link to 'Checkboxes' which I am about to click.",
		after: "The homepage contains a link to 'Checkboxes'.",
		kind: 'trimmed',
	},
	{
		before: 'The first checkbox is unchecked and I will now click it to see if it becomes checked.',
		after: 'The first checkbox is unchecked.',
		kind: 'trimmed',
	},
	{
		before:
			'The dropdown menu was interactable and contains options, but I need to explore other parts of the application.',
		after: 'The dropdown menu was interactable and contains options.',
		kind: 'trimmed',
	},

	// --- pure narration: nothing observed, so nothing to keep ----------------------
	{
		before: 'Navigating back to the homepage to explore another link.',
		after: null,
		kind: 'dropped',
	},
	{
		before: 'Taking a snapshot to understand the initial layout and available links.',
		after: null,
		kind: 'dropped',
	},
	{
		before: 'Take a snapshot to understand the initial layout and navigation options of the homepage.',
		after: null,
		kind: 'dropped',
	},

	// --- an observation that merely starts with an action verb: must survive -------
	{
		before: 'Selecting an option from the dropdown updates the page without a reload.',
		after: 'Selecting an option from the dropdown updates the page without a reload.',
		kind: 'kept',
	},
	{
		before: "Clicking the 'Add Element' button adds a new element to the page.",
		after: "Clicking the 'Add Element' button adds a new element to the page.",
		kind: 'kept',
	},

	// --- movement, past tense: records that the agent moved, not what the app does --
	{
		before: 'Navigated back to the homepage.',
		after: null,
		kind: 'dropped',
	},
	{
		before: "Clicked the 'Elemental Selenium' link to explore further.",
		after: null,
		kind: 'dropped',
	},
];

let failures = 0;

for (const testCase of CASES) {
	const result = cleanNote(testCase.before);
	const problems: string[] = [];

	if (result.note !== testCase.after) {
		problems.push(`expected ${JSON.stringify(testCase.after)}, got ${JSON.stringify(result.note)}`);
	}
	const shouldBeTrimmed = testCase.kind !== 'kept';
	if (result.trimmed !== shouldBeTrimmed) {
		problems.push(`trimmed flag should be ${shouldBeTrimmed}`);
	}
	if (problems.length > 0) failures += 1;

	const mark = problems.length === 0 ? 'pass' : 'FAIL';
	console.log(`  ${mark}  [${testCase.kind}] ${testCase.before}`);
	if (problems.length > 0) {
		console.log(`        ${problems.join('; ')}`);
	} else if (result.note !== testCase.before) {
		console.log(`        -> ${JSON.stringify(result.note)}`);
	}
}

console.log(failures === 0 ? `\nall ${CASES.length} note cases correct` : `\n${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
