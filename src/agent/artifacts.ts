/**
 * Run artefacts.
 *
 * The product of a run is two documents, not a transcript:
 *   findings.md   - what is broken or risky
 *   app-guide.md  - how the application works, for someone who has never seen it
 *
 * The raw transcript is kept alongside them as JSONL, because when a report
 * looks wrong the first question is always "what did it actually see".
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type Severity = 'high' | 'medium' | 'low';

export interface Finding {
	severity: Severity;
	title: string;
	detail?: string;
}

export interface StepRecord {
	step: number;
	at: string;
	url: string | null;
	thought: string | null;
	tool: string | null;
	args: Record<string, unknown> | null;
	learned: string | null;
	finding: Finding | null;
	/**
	 * The note as it was kept, after any plan was trimmed off the end. Null when
	 * nothing was kept.
	 */
	noteKept: string | null;
	/**
	 * Why the note was trimmed or dropped, or null when it went in unchanged.
	 *
	 * Without this the transcript cannot explain itself: reading run.jsonl would not
	 * tell you whether a note was never written or written and then rejected, and
	 * that is the first question when the guide looks thin.
	 */
	noteIssue: string | null;
	/**
	 * Set when the harness refused the action before it ran - a tool that does not
	 * exist, the console read twice on one page, a navigation out of the application.
	 *
	 * Recorded because a refusal costs a step and produces nothing, and "the run took
	 * nine steps and established almost nothing" is a different story once the
	 * transcript can say that four of them were refused.
	 */
	refused: string | null;
	/**
	 * Set when the harness took the step itself rather than doing what the model asked,
	 * and the tool and args in this record describe what the harness did. This says
	 * what the model wanted and why it was overruled. There is one case of it so far:
	 * the widening nudge, ignored five steps running.
	 */
	overridden: string | null;
	toolMs: number;
	llmMs: number;
	promptTokens: number;
	outputTokens: number;
	resultPreview: string;
	isError: boolean;
	/**
	 * Elements that were actionable on the page at this point, harvested from the
	 * snapshot rather than written by the model. The guide stays useful even when
	 * the model forgets to fill in "learned".
	 */
	actions: string[];
}

const SEVERITY_ORDER: Severity[] = ['high', 'medium', 'low'];
const SEVERITY_LABEL: Record<Severity, string> = {
	high: 'High - blocks a task',
	medium: 'Medium - degrades a task',
	low: 'Low - cosmetic or minor',
};

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/**
 * How alike two findings must be before they are treated as one problem.
 *
 * Calibrated in tools/check-finding-dedupe.ts: reworded reports of a single
 * issue measured 0.50, genuinely different defects measured at most 0.14. The
 * threshold sits between the two groups rather than on the edge of one.
 */
export const FINDING_DUPLICATE_THRESHOLD = 0.45;

/**
 * How alike two notes must be before they are treated as one observation.
 *
 * Higher than the finding threshold, and it has to be, because a note is one
 * sentence: two sentences about the same control share most of their words even
 * when they say the opposite. "The first checkbox is now checked after clicking
 * it" and "The first checkbox is unchecked" score 0.67 - most of the words, and
 * two different facts. Reworded restatements of one fact measured 0.83 and up, so
 * the threshold sits between the two, and tools/check-notes.ts holds both groups.
 *
 * It is word overlap, not meaning. A note that contains every word of another and
 * adds a number - "adds an element" and "adds two elements" - scores 1.00 and will
 * be treated as a repeat.
 */
export const NOTE_DUPLICATE_THRESHOLD = 0.75;

function normaliseSeverity(value: unknown): Severity {
	const text = String(value ?? '').toLowerCase();
	return SEVERITY_ORDER.includes(text as Severity) ? (text as Severity) : 'low';
}

export function parseFinding(value: unknown): Finding | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	const title = typeof raw.title === 'string' ? raw.title.trim() : '';
	if (title === '') return null;
	const detail = typeof raw.detail === 'string' ? raw.detail.trim() : '';
	return { severity: normaliseSeverity(raw.severity), title, detail };
}

/**
 * Words that carry no signal about which problem a finding describes. Almost
 * every finding mentions a page, a click or an error, so those words would make
 * unrelated findings look alike.
 */
const STOP_WORDS = new Set([
	'the', 'and', 'but', 'for', 'with', 'when', 'while', 'after', 'before',
	'from', 'into', 'onto', 'upon', 'that', 'this', 'these', 'those', 'there',
	'they', 'them', 'their', 'its', 'was', 'were', 'are', 'does', 'did', 'not',
	'but', 'may', 'can', 'could', 'would', 'should', 'seem', 'seems', 'likely',
	'page', 'pages', 'click', 'clicks', 'clicking', 'clicked', 'error', 'errors',
	'issue', 'issues', 'problem', 'problems', 'appears', 'appear', 'present',
	'also', 'only', 'however', 'which', 'where', 'overall', 'affect', 'affects',
]);

/**
 * The set of meaningful words in a piece of text, used to decide whether two
 * sentences describe the same thing. Findings and notes both go through this;
 * they differ only in what they compare against and how alike is alike enough.
 */
export function textSignature(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.replace(/[^a-z0-9\s]+/g, ' ')
			.split(/\s+/)
			.filter((word) => word.length > 3 && !STOP_WORDS.has(word)),
	);
}

/**
 * The set of meaningful words in a finding. Used to decide whether two findings
 * describe the same problem.
 */
export function findingSignature(finding: Finding): Set<string> {
	return textSignature(`${finding.title} ${finding.detail ?? ''}`);
}

/**
 * Overlap coefficient: shared words over the smaller set.
 *
 * Jaccard would be too blunt here, because one report of the same problem is
 * often much longer than another - the model elaborates on the repeat.
 */
export function similarity(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const word of a) if (b.has(word)) shared += 1;
	return shared / Math.min(a.size, b.size);
}

export class RunArtifacts {
	private readonly steps: StepRecord[] = [];
	private readonly notes: string[] = [];
	private readonly findings: Finding[] = [];
	private readonly visitedUrls: string[] = [];
	private readonly jsonlPath: string;

	constructor(
		readonly dir: string,
		private readonly meta: {
			url: string;
			model: string;
			startedAt: string;
			/**
			 * Which prompt produced these notes. Recorded because a run's notes are only
			 * as good as the contract the model was working to, and app-guide.md outlives
			 * the version of the prompt that wrote it.
			 */
			promptVersion: string;
		},
	) {
		mkdirSync(dir, { recursive: true });
		this.jsonlPath = path.join(dir, 'run.jsonl');
	}

	/**
	 * Add a note to what the run has established.
	 *
	 * Returns false when the note was already established in other words, so the
	 * caller can record that in the transcript. A note that reads as kept in
	 * run.jsonl and is missing from the guide is otherwise a mystery.
	 */
	addNote(note: string): boolean {
		const clean = note.replace(/\s+/g, ' ').trim();
		if (clean === '') return false;
		// A model working one page for several steps restates the same observation every
		// time. One run put this line into the guide six times: "The dropdown menu is
		// currently selected with a disabled option 'Please select an option'." Six
		// copies of a true sentence is still a worse document than one copy of it.
		//
		// Byte-identical repeats were the first version of this, and they are the easy
		// half. The other half is the model restating one observation in different
		// words, which is the same failure the findings list already had, so it is
		// measured the same way - see NOTE_DUPLICATE_THRESHOLD for why the threshold is
		// a different number.
		const signature = textSignature(clean);
		const duplicate = this.notes.some(
			(existing) => similarity(signature, textSignature(existing)) >= NOTE_DUPLICATE_THRESHOLD,
		);
		if (duplicate) return false;
		this.notes.push(clean);
		return true;
	}

	addFinding(finding: Finding): void {
		// Dedupe by content, not by title. A model reporting the same problem
		// three times will not use the same words: this run produced "Console
		// errors when interacting with dropdown menu", "Console errors due to
		// failed resource loading" and "Console errors on dropdown page" for one
		// analytics script that does not resolve. Exact title matching let all
		// three through and the report claimed three defects where there was one.
		const signature = findingSignature(finding);
		const duplicate = this.findings.find((existing) => similarity(signature, findingSignature(existing)) >= FINDING_DUPLICATE_THRESHOLD);
		if (duplicate) {
			// Keep the more serious of the two; the model usually escalates on the
			// repeat rather than the first sighting.
			if (SEVERITY_RANK[finding.severity] < SEVERITY_RANK[duplicate.severity]) {
				duplicate.severity = finding.severity;
			}
			return;
		}
		this.findings.push(finding);
	}

	/**
	 * Record a page the run actually reached. This is coverage evidence, and it is
	 * gathered from tool results rather than from the model's own account, so it
	 * cannot be inflated by a model that believes it went somewhere it did not.
	 */
	addVisitedUrl(url: string): void {
		if (url === '' || this.visitedUrls.includes(url)) return;
		this.visitedUrls.push(url);
	}

	get visitedCount(): number {
		return this.visitedUrls.length;
	}

	record(step: StepRecord): void {
		this.steps.push(step);
		appendFileSync(this.jsonlPath, `${JSON.stringify(step)}\n`, 'utf8');
	}

	noteList(): string[] {
		return [...this.notes];
	}

	get stepCount(): number {
		return this.steps.length;
	}

	get findingCount(): number {
		return this.findings.length;
	}

	/** Build and persist every artefact at the end of a run. */
	finalise(summaryLines: string[]): string[] {
		const written: string[] = [];
		// A run that recorded no steps still gets the file, so which artefacts a run
		// directory holds never depends on how far the run got. This matters most on
		// the path where the run died early, which is exactly when someone is looking.
		if (!existsSync(this.jsonlPath)) writeFileSync(this.jsonlPath, '', 'utf8');
		writeFileSync(path.join(this.dir, 'findings.md'), this.renderFindings(), 'utf8');
		written.push('findings.md');
		writeFileSync(path.join(this.dir, 'app-guide.md'), this.renderGuide(), 'utf8');
		written.push('app-guide.md');
		writeFileSync(
			path.join(this.dir, 'summary.json'),
			`${JSON.stringify({ ...this.meta, steps: this.steps.length, findings: this.findings.length, notes: this.notes.length, lines: summaryLines }, null, 2)}\n`,
			'utf8',
		);
		written.push('summary.json');
		return written;
	}

	private renderFindings(): string {
		const head = [
			'# Exploratory testing findings',
			'',
			`Target: ${this.meta.url}  `,
			`Model: ${this.meta.model}  `,
			`Run started: ${this.meta.startedAt}  `,
			`Steps taken: ${this.steps.length}`,
			'',
			'> Produced by an autonomous exploratory agent. Every item below came from a',
			'> tool result the agent actually observed. Treat them as leads to reproduce,',
			'> not as confirmed defects.',
			'',
		];

		const lines = [...head];

		if (this.findings.length === 0) {
			lines.push('No defects were observed in this run.', '');
		}

		// Coverage belongs here whether or not anything was found. A report that lists
		// three defects after reaching one page reads very differently from the same
		// three after reaching twenty, and a reader has no way to tell the difference
		// unless the report says which it was.
		lines.push(
			'## Coverage',
			'',
			`${this.steps.length} steps reached ${this.visitedUrls.length} page${this.visitedUrls.length === 1 ? '' : 's'} of the application.`,
			'',
			...(this.visitedUrls.length > 0
				? this.visitedUrls.map((url) => `- ${url}`)
				: ['- none recorded']),
			'',
			'Pages that were never opened are not evidence of health.',
			'',
		);

		if (this.findings.length === 0) return lines.join('\n');

		const sorted = [...this.findings].sort(
			(a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
		);
		for (const severity of SEVERITY_ORDER) {
			const group = sorted.filter((finding) => finding.severity === severity);
			if (group.length === 0) continue;
			lines.push(`## ${SEVERITY_LABEL[severity]}`, '');
			for (const finding of group) {
				lines.push(`### ${finding.title}`, '');
				if (finding.detail) lines.push(finding.detail, '');
			}
		}
		return lines.join('\n');
	}

	private renderGuide(): string {
		const lines = [
			'# Application guide',
			'',
			`Target: ${this.meta.url}  `,
			`Model: ${this.meta.model}  `,
			`Run started: ${this.meta.startedAt}`,
			'',
			'> How this application behaves, as established by an autonomous exploratory',
			'> agent. It records what was observed, not what was assumed - gaps are',
			'> genuine gaps.',
			'',
			`## Pages reached (${this.visitedUrls.length})`,
			'',
			...(this.visitedUrls.length > 0
				? this.visitedUrls.map((url) => `- ${url}`)
				: ['- none recorded']),
			'',
		];

		if (this.notes.length === 0) {
			return [...lines, 'The run established nothing worth recording.', ''].join('\n');
		}

		lines.push('## What the run established', '');
		for (const note of this.notes) lines.push(`- ${note}`);
		lines.push('', '## Path taken', '');
		for (const step of this.steps) {
			const action = step.tool ? `${step.tool}(${JSON.stringify(step.args ?? {})})` : 'no action';
			lines.push(`${step.step}. ${action}${step.isError ? '  **failed**' : ''}`);
			if (step.thought) lines.push(`   - why: ${step.thought}`);
			if (step.learned) lines.push(`   - learned: ${step.learned}`);
			if (step.actions.length > 0) lines.push(`   - on the page: ${step.actions.join(' | ')}`);
		}
		lines.push('');
		return lines.join('\n');
	}
}
