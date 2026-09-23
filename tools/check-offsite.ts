/**
 * Calibration check for the off-site guard.
 *
 * The guard decides whether a page belongs to the application under test. Get it
 * too strict and a legitimate page of the application is treated as foreign, so
 * the loop keeps shoving the model back and coverage under-reports. Get it too
 * loose and a vendor's marketing site counts as coverage, which is how a run that
 * spent its budget on elementalselenium.com could report having explored the
 * application.
 *
 * Run: npm test
 */
import { isApplicationUrl } from '../src/agent/loop.js';

const START = 'https://the-internet.herokuapp.com/';

interface Case {
	url: string;
	expected: boolean;
	why: string;
}

const CASES: Case[] = [
	{ url: 'https://the-internet.herokuapp.com/abtest', expected: true, why: 'another path on the same host' },
	{ url: 'https://the-internet.herokuapp.com/', expected: true, why: 'the start URL itself' },
	{ url: 'https://elementalselenium.com/', expected: false, why: 'the third-party site a run wandered into' },
	{ url: 'https://github.com/tourdedave/the-internet', expected: false, why: 'a link to the source repository' },
	{ url: 'https://notthe-internet.herokuapp.com/', expected: false, why: 'a lookalike host that merely ends with the same letters' },
	{ url: 'http://the-internet.herokuapp.com/abtest', expected: false, why: 'a different scheme and therefore a different origin' },
	{ url: 'chrome-error://chromewebdata/', expected: false, why: 'a browser error page belongs to no application' },
	{ url: 'not a url', expected: false, why: 'unparseable input must not crash the loop' },
];

// Subdomain handling is the reason this guard is not a plain origin comparison.
const SUBDOMAIN_CASES: Case[] = [
	{ url: 'https://docs.example.com/guide', expected: true, why: 'sibling subdomain of the start URL' },
	{ url: 'https://app.example.com/login', expected: true, why: 'the application itself' },
	{ url: 'https://evil-example.com/', expected: false, why: 'shares a suffix but is a different registrable domain' },
];

let failures = 0;

function run(label: string, startUrl: string, cases: Case[]): void {
	console.log(`${label}  (start: ${startUrl})`);
	for (const testCase of cases) {
		const actual = isApplicationUrl(testCase.url, startUrl);
		const pass = actual === testCase.expected;
		if (!pass) failures += 1;
		console.log(
			`  ${pass ? 'pass' : 'FAIL'}  ${String(actual).padEnd(5)} ${testCase.url.padEnd(52)} ${testCase.why}`,
		);
	}
}

run('host', START, CASES);
console.log('');
run('subdomains', 'https://example.com/', SUBDOMAIN_CASES);

console.log(failures === 0 ? '\nall off-site cases correct' : `\n${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
