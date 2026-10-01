/**
 * Calibration check for the shortlist and the ref guard.
 *
 * Two things are being pinned here, and they pull in opposite directions, which is why
 * they are in one file:
 *
 *   - too strict -> a link that is really on the page is refused, and the run loses a
 *                  step to a false accusation. A guide that guesses wrong is worse than
 *                  one that misses something, and the same is true of a guard.
 *   - too loose  -> the model acts on a ref the page never offered, the click lands on
 *                  a container, nothing changes, and the rest of the budget goes on
 *                  re-reading a page that is not going to change.
 *
 * The second is not hypothetical. `LOGIN_PAGE` is the accessibility snapshot of the
 * Swag Labs login page, copied verbatim from the `.playwright-mcp` page file of the
 * run that failed: the model typed a username and a password and then clicked `e14`,
 * which is the empty `generic` container holding the error message, while the login
 * button was `e15`. The shortlist was empty at that moment because `browser_type`
 * returns only the Playwright call it ran, with no snapshot body - so the model filled
 * the gap from the previous page and Playwright resolved the stale ref anyway.
 *
 * Run: npm test
 */
import { extractActions, unknownTarget } from '../src/agent/snapshot.js';

/** Verbatim: page-2026-10-01T13-40-53-829Z.yml, the login page after the mistyped click. */
const LOGIN_PAGE = `- generic [ref=e3]:
  - generic [ref=e4]: Swag Labs
  - main [ref=e5]:
    - form "Login" [ref=e9]:
      - textbox "Username" [ref=e11]: standard_user
      - textbox "Password" [ref=e13]: secret_sauce
      - button "Login" [ref=e15] [cursor=pointer]
    - generic [ref=e17]:
      - generic [ref=e18]:
        - heading "Accepted usernames are:" [level=4] [ref=e19]
        - text: standard_userlocked_out_userproblem_userperformance_glitch_usererror_uservisual_user
      - generic [ref=e20]:
        - heading "Password for all users:" [level=4] [ref=e21]
        - text: secret_sauce`;

/** A page with more links than the menu shows, for the false-accusation case. */
const LONG_PAGE = Array.from(
	{ length: 20 },
	(_, index) => `  - link "Board ${index + 1}" [ref=e${index + 1}]`,
).join('\n');

const HOT_SNAPSHOT = `### Page
- Page URL: https://example.com/
### Snapshot
- [Snapshot](.playwright-mcp\\page-2026-10-01T13-40-53-829Z.yml)
`;

let failures = 0;

function check(label: string, condition: boolean, detail = ''): void {
	if (!condition) failures += 1;
	console.log(`  ${condition ? 'pass' : 'FAIL'}  ${label}${condition || detail === '' ? '' : `\n        ${detail}`}`);
}

console.log('what the shortlist offers');

const loginActions = extractActions(LOGIN_PAGE, 300);
check(
	'the login page offers exactly the three things a user can act on',
	loginActions.map((action) => action.ref).join(',') === 'e11,e13,e15',
	`got ${loginActions.map((action) => `${action.ref} (${action.label})`).join(', ')}`,
);
check(
	'a heading and a container are not offered, though they carry refs',
	!loginActions.some((action) => ['e14', 'e17', 'e19'].includes(action.ref)),
);
check('the empty error container is not offered', !loginActions.some((action) => action.ref === 'e14'));

const longActions = extractActions(LONG_PAGE, 300);
check('a long page harvests every link', longActions.length === 20, `got ${longActions.length}`);
check('while the menu shows only the first twelve', longActions.slice(0, 12).length === 12);

console.log('\nthe ref guard');
check('the login button is allowed', unknownTarget('e15', loginActions) === null);
check('the username field is allowed', unknownTarget('e11', loginActions) === null);
check(
	'the container one digit from the login button is refused - the real failure',
	unknownTarget('e14', loginActions) !== null,
);
check(
	'a ref from another page is refused',
	unknownTarget('e2', loginActions) !== null,
);
check(
	'an empty shortlist refuses everything, including a ref that looks plausible',
	unknownTarget('e11', []) !== null,
);
check(
	'and says what to do about it rather than only refusing',
	(unknownTarget('e11', []) ?? '').includes('Take a snapshot'),
);
check(
	'the refusal names the refs that would work',
	['e11', 'e13', 'e15'].every((ref) => (unknownTarget('e14', loginActions) ?? '').includes(ref)),
);
check(
	'the thirteenth link is allowed even though the menu cannot show it',
	unknownTarget('e13', longActions) === null,
);
check(
	'the last of twenty links is allowed too',
	unknownTarget('e20', longActions) === null,
);

console.log('\na tool result with no snapshot');
check(
	'there are no refs to offer',
	extractActions(HOT_SNAPSHOT, 300).length === 0,
	`got ${extractActions(HOT_SNAPSHOT, 300).length}`,
);
check(
	'so the guard is the only thing standing between the model and a guess',
	unknownTarget('e14', extractActions(HOT_SNAPSHOT, 300)) !== null,
);

console.log(failures === 0 ? '\nall shortlist cases correct' : `\n${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
