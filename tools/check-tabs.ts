/**
 * Calibration check for the open-tab parser.
 *
 * A link that opens in a new tab leaves the current page unchanged, which reads
 * exactly like a dead link. The parser turns Playwright's tab list into a line
 * the model cannot miss. It is checked here against the literal tool output from
 * the run that produced the false positive, because a regex that silently stops
 * matching would quietly bring that false positive back.
 *
 * Run: npm run check:tabs
 */
import { describeOtherTabs } from '../src/agent/loop.js';

/** Copied verbatim from a real tool result, tabs and all. */
const REAL_RESULT = `### Ran Playwright code
\`\`\`js
await page.getByRole('link', { name: 'Elemental Selenium' }).click();
\`\`\`
### Open tabs
- 0: (current) [The Internet](https://the-internet.herokuapp.com/abtest)
- 1: [Home | Elemental Selenium](https://elementalselenium.com/)
### Page
- Page URL: https://the-internet.herokuapp.com/abtest
- Page Title: The Internet
- Console: 4 errors, 0 warnings
`;

const SINGLE_TAB = `### Open tabs
- 0: (current) [The Internet](https://the-internet.herokuapp.com/abtest)
### Page
- Page URL: https://the-internet.herokuapp.com/abtest
`;

const NO_TABS = `### Page
- Page URL: https://the-internet.herokuapp.com/
- Page Title: The Internet
`;

interface Case {
	name: string;
	input: string;
	/** null means "no note should be added". */
	expect: 'null' | { tabs: number; mentions: string[] };
}

const CASES: Case[] = [
	{
		name: 'two tabs, external destination named',
		input: REAL_RESULT,
		expect: { tabs: 2, mentions: ['2 open tabs', 'https://elementalselenium.com/', 'NOT a broken link'] },
	},
	{ name: 'one tab', input: SINGLE_TAB, expect: 'null' },
	{ name: 'no tab list at all', input: NO_TABS, expect: 'null' },
];

let failures = 0;

for (const testCase of CASES) {
	const actual = describeOtherTabs(testCase.input);

	if (testCase.expect === 'null') {
		const pass = actual === null;
		if (!pass) failures += 1;
		console.log(`  ${pass ? 'pass' : 'FAIL'}  ${testCase.name}  -> ${actual === null ? 'null' : 'unexpected note'}`);
		continue;
	}

	const problems: string[] = [];
	if (actual === null) {
		problems.push('expected a note, got null');
	} else {
		if (!actual.includes(`${testCase.expect.tabs} open tabs`)) {
			problems.push(`missing tab count ${testCase.expect.tabs}`);
		}
		for (const fragment of testCase.expect.mentions) {
			if (!actual.includes(fragment)) problems.push(`missing "${fragment}"`);
		}
	}
	if (problems.length > 0) failures += 1;
	console.log(`  ${problems.length === 0 ? 'pass' : 'FAIL'}  ${testCase.name}${problems.length > 0 ? `  -> ${problems.join('; ')}` : ''}`);
}

console.log(failures === 0 ? '\nall tab cases correct' : `\n${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
