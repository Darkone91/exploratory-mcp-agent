/**
 * Calibration check for the operator-facing defaults.
 *
 * The browser window is meant to be visible unless the operator hides it: watching
 * the agent work is the point of the tool, and the README, the --help text and the
 * field comment all said so. The code said the opposite - the two flags were written
 * as "headless, unless --headed", which is a different rule - and nothing noticed,
 * because a run in a hidden browser looks exactly like a run with no browser at all
 * from inside a terminal. A default that is wrong in a way no one can see is worth
 * pinning, which is what this file is for.
 *
 * The flag parsing around it is checked too: `--steps --headless` must not read the
 * next flag as the step count.
 *
 * Run: npm test
 */
import { loadConfig } from '../src/config.js';

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
	const pass = JSON.stringify(actual) === JSON.stringify(expected);
	if (!pass) failures += 1;
	console.log(
		`  ${pass ? 'pass' : 'FAIL'}  ${label}${pass ? '' : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`,
	);
}

console.log('the window');
check('no flag at all asks for a visible window', loadConfig([], {}).headless, false);
check('--headed is a visible window', loadConfig(['--headed'], {}).headless, false);
check('--headless is a hidden one', loadConfig(['--headless'], {}).headless, true);
check('--headed wins when both are given', loadConfig(['--headless', '--headed'], {}).headless, false);

console.log('\nthe budget');
check('--steps 7 is seven', loadConfig(['--steps', '7'], {}).maxSteps, 7);
check('--steps 2.7 is floored', loadConfig(['--steps', '2.7'], {}).maxSteps, 2);
check('--steps 0 is not a budget', loadConfig(['--steps', '0'], {}).maxSteps, 12);
check('a flag is not a value', loadConfig(['--steps', '--headless'], {}).maxSteps, 12);
check('MAX_STEPS is the fallback', loadConfig([], { MAX_STEPS: '30' }).maxSteps, 30);

console.log('\nthe target');
check('--url wins over START_URL', loadConfig(['--url', 'https://cli.example/'], { START_URL: 'https://env.example/' }).startUrl, 'https://cli.example/');
check('START_URL is the fallback', loadConfig([], { START_URL: 'https://env.example/' }).startUrl, 'https://env.example/');
check('no target is an empty string, not a crash', loadConfig([], {}).startUrl, '');

console.log('\nthe reachable hosts');
check(
	'--allow-host and ALLOWED_HOSTS merge, in that order',
	loadConfig(
		['--allow-host', 'a.example', '--allow-host', 'b.example'],
		{ ALLOWED_HOSTS: 'c.example, d.example' },
	).allowedHosts,
	['a.example', 'b.example', 'c.example', 'd.example'],
);
check('nothing allowed by default', loadConfig([], {}).allowedHosts, []);
check('the default browser is the one playwright installs', loadConfig([], {}).browser, 'chromium');

console.log(failures === 0 ? '\nall config cases correct' : `\n${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
