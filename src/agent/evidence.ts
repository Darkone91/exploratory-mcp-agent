/**
 * Claim checking.
 *
 * The model writes a short summary of each step into "learned", and that field is
 * the only source for app-guide.md. So when it invents something, the invention
 * does not stay in a chat log - it is written into documentation that a teammate
 * is meant to trust.
 *
 * It does invent. A run reported that the A/B testing page "contains a button
 * labeled 'Toggle'" twice, and no such button has ever existed on that page.
 *
 * A model cannot be talked out of this by asking it to be careful, but the
 * invention is checkable. Naming a control means quoting its name, and a quoted
 * name either appears in what the browser returned or it does not. Anything the
 * browser has shown is kept, so a claim may refer back to an earlier page; a term
 * that appears nowhere in the run at all was never observed anywhere.
 */

/**
 * Words that assert a control exists, mapped to the token that would be in the
 * accessibility tree if one had actually been seen.
 *
 * The mapping is deliberately short, and only includes words that mean one thing.
 * "Field", "input" and "toggle" are left out because they are ambiguous: a reader
 * cannot tell from the word alone which role is being claimed, and a check that
 * guesses wrong produces false accusations, which are worse than a missed one.
 */
const CONTROL_ROLES: Record<string, string> = {
	button: 'button',
	checkbox: 'checkbox',
	combobox: 'combobox',
	dropdown: 'combobox',
	switch: 'switch',
	link: 'link',
	radio: 'radio',
	slider: 'slider',
	tab: 'tab',
	textbox: 'textbox',
};

/**
 * Words in `claim` that assert a control exists when the evidence contains no such
 * role.
 *
 * This exists because the quoted-name check has a hole that a real run walked
 * through. The model reported that the A/B testing page had "a button labeled
 * 'Toggle'" - caught, because naming a control that way means quoting it. On a later
 * run the same page grew "a button to refresh the page", unquoted, and it sailed
 * past the check and into the guide. That page has no `<button>` element at all, and
 * does not contain the word "refresh" anywhere in its 1,850 bytes.
 *
 * The quoted case was not lucky, it was protected by a different accident: "toggle"
 * is a rare enough string that its absence proved something. "Button" is ordinary
 * English that a model reaches for when it is filling a gap, so its absence proves
 * something too - as long as the claim is checked at all.
 *
 * `evidence` is everything the browser has returned so far this run, so a claim may
 * legitimately refer back to a control seen on an earlier page. What it cannot do is
 * invent one.
 */
export function unsupportedControlWords(claim: string, evidence: string): string[] {
	const haystack = evidence.toLowerCase();
	const unsupported = new Set<string>();

	// A control word inside quotes is part of a name, and names are the other check's
	// job. This is not a nicety: on the very first run of this check, the claim "the
	// homepage lists several example pages, including a 'Dropdown' page" was read as a
	// claim about a combobox. The homepage has a *link* called Dropdown, no combobox
	// had been seen yet, and a true observation was dropped as unverified. Losing a
	// correct note is worse than missing a wrong one, which is exactly why this rule
	// requires two conditions and why this exclusion exists.
	const prose = claim.replace(QUOTED, ' ');

	for (const raw of prose.toLowerCase().replace(/[^a-z\s]+/g, ' ').split(/\s+/)) {
		const word = raw.replace(/es$/, '').replace(/s$/, '');
		const role = word === '' ? undefined : CONTROL_ROLES[word];
		if (role === undefined) continue;
		if (!haystack.includes(role)) unsupported.add(raw);
	}
	return [...unsupported];
}

const QUOTED = /'([^'\n]{4,})'|"([^"\n]{4,})"|`([^`\n]{4,})`|\u2018([^\u2019\n]{4,})\u2019|\u201c([^\u201d\n]{4,})\u201d/g;

/** Names quoted inside a claim, e.g. the `Toggle` in "a button labeled 'Toggle'". */
export function quotedTerms(claim: string): string[] {
	const terms = new Set<string>();
	for (const match of claim.matchAll(QUOTED)) {
		const term = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? '').trim();
		if (term !== '') terms.add(term);
	}
	return [...terms];
}

/**
 * Quoted names in `claim` that appear nowhere in `evidence`.
 *
 * An empty result means every name the claim uses has been seen somewhere in this
 * run. It does not prove the claim is true - see the limitations section of the
 * README - but it does catch a control that was invented outright.
 */
export function unsupportedTerms(claim: string, evidence: string): string[] {
	const haystack = evidence.toLowerCase();
	return quotedTerms(claim).filter((term) => !haystack.includes(term.toLowerCase()));
}
