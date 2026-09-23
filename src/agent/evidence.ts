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

/** Straight and typographic quotes are both used in model output. */
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
