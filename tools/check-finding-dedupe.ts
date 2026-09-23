/**
 * Calibration check for finding de-duplication.
 *
 * The similarity threshold decides two things at once, and both matter:
 *   - too lax  -> one problem is reported as several, which is how a report
 *                 loses a reader's trust
 *   - too tight -> two real problems collapse into one, which is worse,
 *                 because the hidden one is never followed up
 *
 * The pairs below are real: the "same" cases are the three findings an actual
 * run produced for a single analytics script that does not resolve, and the
 * "different" cases are defects that share vocabulary but are not the same bug.
 *
 * Run: npm run check:dedupe
 */
import { FINDING_DUPLICATE_THRESHOLD as THRESHOLD, findingSignature, type Finding } from '../src/agent/artifacts.js';

/** Same problem, three different wordings. These must all collapse into one. */
const SAME: Array<[Finding, Finding]> = [
	[
		{
			severity: 'medium',
			title: 'Console errors when interacting with dropdown menu',
			detail:
				"After clicking the dropdown menu, there are 4 console errors present. To reproduce, navigate to the 'Dropdown' page and click on the dropdown menu.",
		},
		{
			severity: 'low',
			title: 'Console errors due to failed resource loading',
			detail:
				'Upon clicking the dropdown menu, the console shows errors related to failed resource loading from an external domain (https://298279967.log.optimizely.com). These do not seem to affect the dropdown functionality directly but may indicate issues with external logging or analytics.',
		},
	],
	[
		{
			severity: 'low',
			title: 'Console errors on dropdown page',
			detail:
				'After clicking the dropdown menu, there are 4 console errors related to failed resource loading from an external domain (https://298279967.log.optimizely.com). These are likely not specific to the dropdown functionality but may affect the overall application performance or logging.',
		},
		{
			severity: 'medium',
			title: 'Console errors when interacting with dropdown menu',
			detail:
				"After clicking the dropdown menu, there are 4 console errors present. To reproduce, navigate to the 'Dropdown' page and click on the dropdown menu.",
		},
	],
];

/** Distinct defects that share vocabulary. These must stay separate. */
const DIFFERENT: Array<[Finding, Finding]> = [
	[
		{
			severity: 'high',
			title: 'Empty password is accepted at login',
			detail: 'Submitting the login form with an empty password logs the user in successfully.',
		},
		{
			severity: 'medium',
			title: 'No lockout after repeated failed logins',
			detail: 'Ten consecutive wrong passwords never lock or throttle the account.',
		},
	],
	[
		{
			severity: 'medium',
			title: 'Search loses the query after pagination',
			detail: 'Going to page two of results clears the search box and shows everything again.',
		},
		{
			severity: 'high',
			title: 'Search crashes on a bracket character',
			detail: 'Typing a single "[" into the search box returns a 500 error page.',
		},
	],
	[
		{
			severity: 'high',
			title: "Broken 'Elemental Selenium' link",
			detail: "Clicking the Elemental Selenium link does not navigate away from the current page.",
		},
		{
			severity: 'medium',
			title: 'Checkboxes reset after reload',
			detail: 'Ticking the first checkbox and reloading the page clears the selection.',
		},
	],
];

function score(a: Finding, b: Finding): number {
	const left = findingSignature(a);
	const right = findingSignature(b);
	if (left.size === 0 || right.size === 0) return 0;
	let shared = 0;
	for (const word of left) if (right.has(word)) shared += 1;
	return shared / Math.min(left.size, right.size);
}

let failures = 0;

console.log(`threshold ${THRESHOLD}\n`);
console.log('must merge:');
for (const [a, b] of SAME) {
	const value = score(a, b);
	const pass = value >= THRESHOLD;
	if (!pass) failures += 1;
	console.log(`  ${pass ? 'pass' : 'FAIL'}  ${value.toFixed(2)}  "${a.title}" / "${b.title}"`);
}

console.log('\nmust stay separate:');
for (const [a, b] of DIFFERENT) {
	const value = score(a, b);
	const pass = value < THRESHOLD;
	if (!pass) failures += 1;
	console.log(`  ${pass ? 'pass' : 'FAIL'}  ${value.toFixed(2)}  "${a.title}" / "${b.title}"`);
}

console.log(failures === 0 ? '\nall pairs classified correctly' : `\n${failures} pair(s) misclassified`);
process.exit(failures === 0 ? 0 : 1);
