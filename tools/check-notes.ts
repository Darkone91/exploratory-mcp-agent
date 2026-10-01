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
 * The second half of the file checks the other half of the same problem: two notes
 * that say the same thing in different words. The threshold for that is measured
 * below rather than guessed, and it is a different number from the one findings use.
 *
 * Run: npm test
 */
import {
	NOTE_DUPLICATE_THRESHOLD,
	similarity,
	textSignature,
} from '../src/agent/artifacts.js';
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

	// --- the same intention written as a statement about the page -------------------
	// Seven of the eight notes a run against a practice shopping site put in the guide
	// were this shape: the agent describing its own next move in the third person.
	{
		before: 'The page state after typing the password needs to be observed.',
		after: null,
		kind: 'dropped',
	},
	{
		before: 'The page state after entering the password is ready for the login button to be clicked.',
		after: null,
		kind: 'dropped',
	},
	{
		before: 'The current page contains information about A/B Testing and provides two options: Variant A and Variant B.',
		after: null,
		kind: 'dropped',
	},
	{
		before:
			"The 'Add to cart' button is present on the product detail page and needs to be clicked to observe its functionality.",
		after: "The 'Add to cart' button is present on the product detail page.",
		kind: 'trimmed',
	},
	{
		before:
			"The 'Remove' button is present on the product detail page after adding an item to the cart, and it needs to be clicked to observe its functionality.",
		after: "The 'Remove' button is present on the product detail page after adding an item to the cart.",
		kind: 'trimmed',
	},

	// --- and the other direction: a real observation that merely mentions a need ----
	{
		before:
			"The 'Remove' button appears on the product detail page after an item is added to the cart.",
		after: "The 'Remove' button appears on the product detail page after an item is added to the cart.",
		kind: 'kept',
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

// --- the note de-duplicator ------------------------------------------------------
//
// A guide that states one fact three ways is a worse document than one that states it
// once, and matching whole strings only caught the repetitions that were identical to
// the character. The pairs below are both real: the first group is one observation the
// model restated on three consecutive steps of a run, and the second is a set of
// genuinely different facts that share most of their words.

const SAME_OBSERVATION: Array<[string, string]> = [
	[
		'The A/B Test Control page provides information about A/B testing, which is a method for businesses to test different versions of a page to determine which version performs better towards a desired outcome such as user actions like click-throughs.',
		'The A/B Test Control page explains A/B testing as a method for businesses to test different versions of a page to determine which version performs better towards a desired outcome such as user actions like click-throughs.',
	],
	[
		'The A/B Test Control page provides information about A/B testing, which is a method for businesses to test different versions of a page to determine which version performs better towards a desired outcome such as user actions like click-throughs.',
		'The A/B Test Control page provides information about A/B testing, explaining it as a method for businesses to test different versions of a page to determine which version performs better towards a desired outcome such as user actions like click-throughs.',
	],
	[
		'The homepage of the application lists various example pages and features.',
		"The homepage lists various example pages and features, including 'A/B Testing'.",
	],
];

const DIFFERENT_OBSERVATIONS: Array<[string, string]> = [
	[
		'The first checkbox is now checked after clicking it.',
		'The first checkbox is unchecked.',
	],
	[
		'The page contains instructions to right-click a box to open a context menu.',
		'The page instructs to right-click in the box to open a context menu, but the action did not produce any visible change or menu.',
	],
	[
		'The first checkbox is now checked after clicking it.',
		'The second checkbox is now unchecked after clicking it.',
	],
	[
		'The homepage of the application displays a list of links to various example pages and a footer with copyright information.',
		'The Checkboxes page contains two checkboxes and a paragraph describing the purpose of the page.',
	],
];

function score(a: string, b: string): number {
	return similarity(textSignature(a), textSignature(b));
}

console.log(`\nnote de-duplication at ${NOTE_DUPLICATE_THRESHOLD}\n`);

console.log('must collapse into one:');
for (const [a, b] of SAME_OBSERVATION) {
	const value = score(a, b);
	const pass = value >= NOTE_DUPLICATE_THRESHOLD;
	if (!pass) failures += 1;
	console.log(`  ${pass ? 'pass' : 'FAIL'}  ${value.toFixed(2)}  ${a.slice(0, 52)}`);
	console.log(`                      ${b.slice(0, 52)}`);
}

console.log('\nmust stay separate:');
for (const [a, b] of DIFFERENT_OBSERVATIONS) {
	const value = score(a, b);
	const pass = value < NOTE_DUPLICATE_THRESHOLD;
	if (!pass) failures += 1;
	console.log(`  ${pass ? 'pass' : 'FAIL'}  ${value.toFixed(2)}  ${a.slice(0, 52)}`);
	console.log(`                      ${b.slice(0, 52)}`);
}

const cases = CASES.length + SAME_OBSERVATION.length + DIFFERENT_OBSERVATIONS.length;
console.log(failures === 0 ? `\nall ${cases} note cases correct` : `\n${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);