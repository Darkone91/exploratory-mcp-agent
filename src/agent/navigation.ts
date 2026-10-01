/**
 * Which URLs the agent may reach, and which ones count as the application.
 *
 * Two jobs that look alike and are not:
 *
 *   - Coverage. `isApplicationUrl` decides whether a page counts as one of the
 *     application's own, so that "this run reached 2 pages" is a statement about
 *     the application rather than about the internet. It was written after a run
 *     followed a link to a vendor's site and spent the rest of its budget there.
 *   - Enforcement. `navigationBlockedReason` decides whether the browser is allowed
 *     to go somewhere at all. Coverage alone was a nudge applied after the fact:
 *     the model wandered off, and then a paragraph of prompt asked it to come back.
 *     Prompts have not been enough anywhere else in this project, so the same
 *     decision now refuses the navigation before it happens.
 *
 * What this is not: a request firewall. The page under test still loads whatever
 * scripts, fonts and analytics it wants from whatever CDN it wants, because
 * blocking those breaks the application and the exploration with it. What is
 * guarded is where the agent's own navigation and clicks may take the browser,
 * which is the path by which a page could otherwise aim the agent at a machine
 * that is not on the internet - a router's admin page, an internal service, or a
 * cloud metadata endpoint whose response would be written into the run's
 * artefacts.
 */
import type { SnapshotAction } from './snapshot.js';

/** Schemes the agent will follow. An application under test is never a file: or data: URL. */
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/**
 * Resolve a navigation target against the current page.
 *
 * The prompt has told the model, in every version of this file, that
 * browser_navigate needs a complete absolute URL and that a bare path fails.
 * It used one anyway: a run sent "/abtest", Playwright looked for https://abtest/,
 * DNS failed, and the agent then reported the resulting error page as a
 * high-severity defect in the application. Prompts persuade; this enforces.
 */
export function resolveNavigation(target: string, base: string): string {
	if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return target;
	try {
		return new URL(target, base).toString();
	} catch {
		return target;
	}
}

/**
 * Browser error pages are noise in a coverage list - nobody tested anything on
 * chrome-error://chromewebdata/.
 */
export function isErrorPage(url: string): boolean {
	return url.startsWith('chrome-error:') || url === 'about:blank' || url.startsWith('data:');
}

/**
 * Whether a URL belongs to the application under test.
 *
 * A run followed a link into a vendor's website and spent the rest of its budget
 * there. Those pages must not count towards coverage either: "this run reached 7
 * pages" is a statement about the application, and a third-party marketing site is
 * not one of its pages.
 */
export function isApplicationUrl(url: string, startUrl: string): boolean {
	try {
		const target = new URL(url);
		const start = new URL(startUrl);
		if (target.origin === start.origin) return true;
		// Sibling subdomains are usually the same product - a login on
		// app.example.com and help on docs.example.com. The leading dot matters:
		// it is what stops notexample.com from matching example.com.
		return (
			target.hostname.endsWith(`.${start.hostname}`) ||
			start.hostname.endsWith(`.${target.hostname}`)
		);
	} catch {
		return false;
	}
}

/**
 * Hosts the operator has allowed by hand, for the flows a host comparison cannot
 * express - a login that hands off to an identity provider, a help site on its own
 * domain. A bare host also covers its subdomains: "okta.com" allows
 * login.okta.com.
 */
function hostAllowed(hostname: string, allowed: readonly string[]): boolean {
	const host = hostname.toLowerCase();
	return allowed.some((entry) => {
		const needle = entry.trim().toLowerCase().replace(/^\.+/, '');
		if (needle === '') return false;
		return host === needle || host.endsWith(`.${needle}`);
	});
}

/**
 * Why the browser may not be sent to `url`, or null when it may.
 *
 * The message is written to be shown to the model, so it says what the rule is
 * rather than just refusing.
 */
export function navigationBlockedReason(
	url: string,
	startUrl: string,
	allowedHosts: readonly string[] = [],
): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return `"${url}" is not a URL the browser can open`;
	}
	if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
		return `the ${parsed.protocol} scheme is not one this agent follows`;
	}
	if (hostAllowed(parsed.hostname, allowedHosts)) return null;
	if (!isApplicationUrl(url, startUrl)) {
		return `${parsed.host} is not part of the application under test (${startUrl})`;
	}
	return null;
}

/**
 * The same decision for a click, using the destination the snapshot gave for that
 * ref.
 *
 * A click navigates just as surely as browser_navigate does, so guarding only the
 * explicit navigation would leave the obvious way around it.
 *
 * Two things make this more delicate than it looks. The destination is only known
 * when the snapshot printed one under the ref, so a ref with no destination is
 * allowed through and the loop falls back to noticing afterwards. And the
 * destination Playwright prints is often a bare path - `/docs` for a link on the
 * same site - which is not a URL at all until it is resolved against the page the
 * model is looking at, exactly as the browser would resolve it. Without that,
 * every ordinary internal link is refused for being unparseable.
 */
export function clickBlockedReason(
	action: SnapshotAction | undefined,
	startUrl: string,
	allowedHosts: readonly string[] = [],
	base?: string | null,
): string | null {
	if (!action?.url) return null;
	const target = base ? resolveNavigation(action.url, base) : action.url;
	return navigationBlockedReason(target, startUrl, allowedHosts);
}
