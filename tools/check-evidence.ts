/**
 * Calibration check for claim verification.
 *
 * Two mechanisms live in evidence.ts and both are checked here, because they fail in
 * opposite directions:
 *
 *   - quoted names: catches "a button labeled 'Toggle'", and would have missed
 *     "a button to refresh the page" entirely, because nothing is quoted
 *   - control roles: catches the unquoted case, and is cruder, so it must not fire on
 *     a claim that names something the run really did see
 *
 * Every "before" string is copied from a real run, and the evidence strings marked
 * verbatim are the actual tool output the model was looking at when it wrote them.
 *
 * Run: npm test
 */
import { unsupportedControlWords, unsupportedTerms } from '../src/agent/evidence.js';

/** Verbatim: the start of the snapshot the model saw when it invented a refresh button. */
const ABTEST_SNAPSHOT = `### Page
- Page URL: https://the-internet.herokuapp.com/abtest
- Page Title: The Internet
- Console: 2 errors, 0 warnings
### Snapshot
\`\`\`yaml
- generic [active] [ref=f1e1]:
  - generic [ref=f1e4]:
    - link "Fork me on GitHub":
      - /url: https://github.com/tourdedave/the-internet
      - img "Fork me on GitHub" [ref=f1e5] [cursor=pointer]
    - generic [ref=f1e7]:
      - heading "A/B Test C
`;

/** Verbatim: the homepage snapshot, which has links and no buttons either. */
const HOME_SNAPSHOT = `### Page
- Page URL: https://the-internet.herokuapp.com/
- Page Title: The Internet
- Console: 2 errors, 0 warnings
### Snapshot
\`\`\`yaml
- generic [active] [ref=e1]:
  - generic [ref=e4]:
    - link "Fork me on GitHub":
      - /url: https://github.com/tourdedave/the-internet
      - img "Fork me on GitHub" [ref=e5] [cursor=pointer]
    - generic [ref=e6]:
      - heading "Welcome to the-internet"
`;

/**
 * Reconstructed, not verbatim: the Add/Remove Elements page does have an
 * "Add Element" button, which is all this case needs to establish.
 */
const ADD_REMOVE_SNAPSHOT = `### Snapshot
- generic [active] [ref=e1]:
  - button "Add Element" [ref=e3] [cursor=pointer]
  - heading "Add/Remove Elements"
`;

interface Case {
	label: string;
	claim: string;
	evidence: string;
	/** Substrings that must be reported as unsupported. */
	expect: string[];
	/** Which mechanism the case is about. */
	via: 'quoted' | 'role';
}

const CASES: Case[] = [
	// --- the hole: an unquoted control that was never on the page ------------------
	{
		label: 'invented refresh button, unquoted (real claim, real evidence)',
		claim:
			'The A/B Testing page displays two versions of a paragraph and a button to refresh the page.',
		evidence: ABTEST_SNAPSHOT,
		expect: ['button'],
		via: 'role',
	},
	{
		label: 'the same invention stated with quotes is caught by the name check too',
		claim: "The A/B Testing page contains a button labeled 'Refresh'.",
		evidence: ABTEST_SNAPSHOT,
		expect: ['Refresh'],
		via: 'quoted',
	},

	// --- controls that really were seen: must not be flagged -----------------------
	{
		label: 'a button that exists',
		claim: "The 'Add/Remove Elements' page contains a button labeled 'Add Element' and a paragraph with instructions.",
		evidence: `${ADD_REMOVE_SNAPSHOT}`,
		expect: [],
		via: 'role',
	},
	{
		label: 'a link that exists',
		claim: 'The homepage contains a link to the A/B Testing page.',
		evidence: HOME_SNAPSHOT,
		expect: [],
		via: 'role',
	},
	{
		label: 'plural control word against a singular role in the tree',
		claim: 'The Checkboxes page contains two checkboxes and a paragraph describing the purpose of the page.',
		evidence: '- checkbox "checkbox 1" [ref=e4] [cursor=pointer]\n- checkbox "checkbox 2" [ref=e5]',
		expect: [],
		via: 'role',
	},

	// --- a synonym has to map to the real role, or this check produces false alarms -
	{
		label: 'dropdown, when the tree says combobox',
		claim: 'The page has a dropdown with three options.',
		evidence: '- combobox [ref=f1e9] [cursor=pointer]',
		expect: [],
		via: 'role',
	},
	{
		label: 'dropdown, when the tree has none',
		claim: 'The page has a dropdown with three options.',
		evidence: ABTEST_SNAPSHOT,
		expect: ['dropdown'],
		via: 'role',
	},

	// --- ambiguous words are deliberately not checked, so they cannot misfire -------
	{
		label: 'ambiguous word (input) is left alone',
		claim: 'The form has an input for the email address.',
		evidence: ABTEST_SNAPSHOT,
		expect: [],
		via: 'role',
	},

	// --- a control word inside a name belongs to the other check --------------------
	{
		label: 'a link called Dropdown is not a claim about a combobox (real claim)',
		claim: "The homepage lists several example pages, including a 'Dropdown' page.",
		evidence: HOME_SNAPSHOT,
		expect: [],
		via: 'role',
	},
];

let failures = 0;

for (const testCase of CASES) {
	const reported =
		testCase.via === 'quoted'
			? unsupportedTerms(testCase.claim, testCase.evidence)
			: unsupportedControlWords(testCase.claim, testCase.evidence);

	const problems: string[] = [];
	for (const expected of testCase.expect) {
		if (!reported.some((term) => term.toLowerCase() === expected.toLowerCase())) {
			problems.push(`expected to flag "${expected}", got ${JSON.stringify(reported)}`);
		}
	}
	if (testCase.expect.length === 0 && reported.length > 0) {
		problems.push(`expected no flags, got ${JSON.stringify(reported)}`);
	}
	if (problems.length > 0) failures += 1;

	console.log(`  ${problems.length === 0 ? 'pass' : 'FAIL'}  [${testCase.via}] ${testCase.label}`);
	if (problems.length > 0) console.log(`        ${problems.join('; ')}`);
}

console.log(failures === 0 ? `\nall ${CASES.length} evidence cases correct` : `\n${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
