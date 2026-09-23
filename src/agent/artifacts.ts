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
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
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
 * The set of meaningful words in a finding. Used to decide whether two findings
 * describe the same problem.
 */
export function findingSignature(finding: Finding): Set<string> {
	const text = `${finding.title} ${finding.detail ?? ''}`.toLowerCase();
	return new Set(
		text
			.replace(/[^a-z0-9\s]+/g, ' ')
			.split(/\s+/)
			.filter((word) => word.length > 3 && !STOP_WORDS.has(word)),
	);
}

/**
 * Overlap coefficient: shared words over the smaller set.
 *
 * Jaccard would be too blunt here, because one report of the same problem is
 * often much longer than another - the model elaborates on the repeat.
 */
function similarity(a: Set<string>, b: Set<string>): number {
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
		private readonly meta: { url: string; model: string; startedAt: string },
	) {
		mkdirSync(dir, { recursive: true });
		this.jsonlPath = path.join(dir, 'run.jsonl');
	}

	/** Notes are what the model has established; they seed the app guide. */
	addNote(note: string): void {
		const clean = note.replace(/\s+/g, ' ').trim();
		if (clean === '') return;
		this.notes.push(clean);
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

		if (this.findings.length === 0) {
			return [
				...head,
				'No defects were observed in this run.',
				'',
				// A thorough clean run and a lazy one produce the same empty report, and
				// that ambiguity is the most misleading thing this tool can output. The
				// run that prompted this spent all 14 of its steps on one page of a
				// twelve-page application. Say what was covered, right next to the
				// claim, so the claim cannot be read as a clean bill of health.
				`Read that with the coverage below in mind: ${this.steps.length} steps reached ${this.visitedUrls.length} page${this.visitedUrls.length === 1 ? '' : 's'}.`,
				'',
				...this.visitedUrls.map((url) => `- ${url}`),
				'',
				'Pages that were never opened are not evidence of health.',
				'',
			].join('\n');
		}

		const sorted = [...this.findings].sort(
			(a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
		);
		const lines = [...head];
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
