/**
 * Calibration check for the off-site guard.
 *
 * Two decisions share the same question - is this URL the application? - and fail
 * in opposite directions:
 *
 *   - Coverage. Get it too strict and a legitimate page of the application is
 *     treated as foreign, so the loop keeps shoving the model back and coverage
 *     under-reports. Get it too loose and a vendor's marketing site counts as
 *     coverage, which is how a run that spent its budget on elementalselenium.com
 *     could report having explored the application.
 *   - Navigation. Get it too loose and a page can aim the agent at anything the
 *     agent's machine can reach, including a cloud metadata endpoint whose answer is
 *     written into the run's artefacts. Get it too strict and an application that
 *     really does live on localhost stops working, which is why the start URL is
 *     always its own application however it is addressed.
 *
 * Run: npm test
 */
import {
	clickBlockedReason,
	isApplicationUrl,
	navigationBlockedReason,
} from '../src/agent/navigation.js';
import type { SnapshotAction } from '../src/agent/snapshot.js';

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

interface GuardCase {
	url: string;
	/** Defaults to the start URL the other cases use. */
	start?: string;
	allowed?: string[];
	expected: boolean;
	why: string;
}

/**
 * The guard, which refuses the navigation rather than counting it afterwards.
 *
 * Every "block" here is a request the agent could otherwise be talked into making,
 * which is why the metadata endpoint is in the list: it is not a web page, it is
 * the answer "here are the credentials for this machine".
 */
const GUARD_CASES: GuardCase[] = [
	{ url: 'https://the-internet.herokuapp.com/abtest', expected: true, why: 'a page of the application' },
	{ url: 'https://the-internet.herokuapp.com.evil.com/', expected: false, why: 'a host that only looks like the application' },
	{ url: 'https://elementalselenium.com/', expected: false, why: 'the vendor site a run wandered into' },
	{ url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/', expected: false, why: 'the cloud metadata endpoint' },
	{ url: 'http://localhost:8080/admin', expected: false, why: "a service on the agent's own machine" },
	{ url: 'http://127.0.0.1:11434/api/tags', expected: false, why: 'the loopback address Ollama answers on' },
	{ url: 'file:///etc/passwd', expected: false, why: 'a scheme the agent never follows' },
	{ url: 'javascript:alert(1)', expected: false, why: 'a scheme the agent never follows' },
	{ url: 'data:text/html,<h1>hi</h1>', expected: false, why: 'a scheme the agent never follows' },
	{ url: 'not a url', expected: false, why: 'unparseable input is refused rather than passed on' },
];

/** An application that really is on localhost is still its own application. */
const LOCAL_APP: GuardCase[] = [
	{ url: 'http://localhost:3000/dashboard', start: 'http://localhost:3000/', expected: true, why: 'its own origin, loopback address and all' },
	{ url: 'http://localhost:11434/api/tags', start: 'http://localhost:3000/', expected: false, why: 'a different port is a different application' },
];

/** The hand-written escape hatch, for a flow that has to leave the application. */
const ALLOWED: GuardCase[] = [
	{ url: 'https://login.okta.com/oauth2/v1/authorize', start: 'https://app.example.com/', allowed: ['okta.com'], expected: true, why: 'a host the operator allowed by hand' },
	{ url: 'https://app.okta.com/x', start: 'https://app.example.com/', allowed: ['okta.com'], expected: true, why: 'a subdomain of an allowed host' },
	{ url: 'https://notokta.com/', start: 'https://app.example.com/', allowed: ['okta.com'], expected: false, why: 'the leading dot applies to the allow list too' },
];

interface ClickCase {
	action: SnapshotAction | undefined;
	/** The page the model was looking at, which a bare href is resolved against. */
	base?: string;
	expected: boolean;
	why: string;
}

/**
 * A click navigates just as surely as browser_navigate does, so its destination is
 * checked the same way - as far as it is known. Where the snapshot printed no
 * `/url:` under the ref, there is nothing to check and the action goes through;
 * that gap is why this is a narrowing of the ways out rather than a seal on them.
 *
 * The bare paths are the interesting ones. Playwright prints an internal link's
 * href exactly as the page wrote it, so `/docs` arrives as `/docs`, and a guard that
 * treated that as a URL would refuse every ordinary link in the application.
 */
const CLICK_CASES: ClickCase[] = [
	{ action: { ref: 'e3', label: 'link "Docs"', url: 'https://docs.vendor.com/' }, expected: false, why: 'a ref whose link leaves the application' },
	{ action: { ref: 'e4', label: 'link "A/B Testing"', url: 'https://the-internet.herokuapp.com/abtest' }, expected: true, why: 'a ref whose link stays inside it' },
	{ action: { ref: 'e5', label: 'button "Save"' }, expected: true, why: 'no destination printed for the ref' },
	{ action: undefined, expected: true, why: 'a ref that was not in the shortlist at all' },
	{ action: { ref: 'e6', label: 'link "Documentation"', url: '/docs' }, expected: true, why: 'a bare path, resolved against the page in front of the model' },
	{ action: { ref: 'e7', label: 'link "Sign in"', url: '/login' }, base: 'https://elementalselenium.com/', expected: false, why: 'a bare path on a page that has already left the application' },
	{ action: { ref: 'e8', label: 'link "Admin"', url: 'http://127.0.0.1:8080/admin' }, expected: false, why: "an href aimed at the machine the agent runs on" },
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

function runGuard(label: string, defaultStart: string, cases: GuardCase[]): void {
	console.log(`${label}`);
	for (const testCase of cases) {
		const start = testCase.start ?? defaultStart;
		const reason = navigationBlockedReason(testCase.url, start, testCase.allowed ?? []);
		const allowed = reason === null;
		const pass = allowed === testCase.expected;
		if (!pass) failures += 1;
		console.log(
			`  ${pass ? 'pass' : 'FAIL'}  ${(allowed ? 'allow' : 'block').padEnd(5)} ${testCase.url.slice(0, 56).padEnd(56)} ${testCase.why}`,
		);
	}
}

function runClicks(): void {
	console.log('clicks');
	for (const testCase of CLICK_CASES) {
		const reason = clickBlockedReason(testCase.action, START, [], testCase.base ?? START);
		const allowed = reason === null;
		const pass = allowed === testCase.expected;
		if (!pass) failures += 1;
		const label = testCase.action?.url ?? testCase.action?.label ?? '(no ref)';
		console.log(
			`  ${pass ? 'pass' : 'FAIL'}  ${(allowed ? 'allow' : 'block').padEnd(5)} ${label.slice(0, 56).padEnd(56)} ${testCase.why}`,
		);
	}
}

run('host', START, CASES);
console.log('');
run('subdomains', 'https://example.com/', SUBDOMAIN_CASES);
console.log('');
runGuard(`navigation guard  (unless stated, start: ${START})`, START, GUARD_CASES);
console.log('');
runGuard('an application on localhost', START, LOCAL_APP);
console.log('');
runGuard('allowed hosts', START, ALLOWED);
console.log('');
runClicks();

console.log(failures === 0 ? '\nall off-site cases correct' : `\n${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
