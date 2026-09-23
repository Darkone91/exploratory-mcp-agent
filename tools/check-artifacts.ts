/**
 * Calibration check for the artefacts themselves.
 *
 * Two things were wrong with findings.md that a live run is a slow way to discover:
 * coverage was printed only when there were no findings, which is backwards, and the
 * transcript could not explain why a note had been dropped. Both are rendering
 * problems, so they can be checked by rendering, in milliseconds, instead of by
 * running the agent and reading the output.
 *
 * Run: npm test
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { RunArtifacts, type StepRecord } from '../src/agent/artifacts.js';

let failures = 0;

function check(label: string, condition: boolean, detail = ''): void {
	if (!condition) failures += 1;
	console.log(`  ${condition ? 'pass' : 'FAIL'}  ${label}${condition || detail === '' ? '' : `\n        ${detail}`}`);
}

function step(overrides: Partial<StepRecord>): StepRecord {
	return {
		step: 1,
		at: new Date().toISOString(),
		url: null,
		thought: null,
		tool: 'browser_snapshot',
		args: {},
		learned: null,
		finding: null,
		noteKept: null,
		noteIssue: null,
		toolMs: 1,
		llmMs: 1,
		promptTokens: 1,
		outputTokens: 1,
		resultPreview: '',
		isError: false,
		actions: [],
		...overrides,
	};
}

const dir = mkdtempSync(path.join(tmpdir(), 'artefacts-check-'));

try {
	// --- a run that found something ------------------------------------------------
	const withFindings = new RunArtifacts(dir, {
		url: 'https://example.com/',
		model: 'test-model',
		startedAt: '2026-01-01T00:00:00.000Z',
	});
	withFindings.addVisitedUrl('https://example.com/');
	withFindings.addVisitedUrl('https://example.com/broken');
	withFindings.addNote('The homepage lists two links.');
	withFindings.addFinding({
		severity: 'high',
		title: 'Save discards the form',
		detail: 'Submitting with an empty title blanks the fields.',
	});
	withFindings.record(step({ step: 1, noteKept: 'The homepage lists two links.', noteIssue: null }));
	withFindings.record(step({ step: 2, noteKept: null, noteIssue: 'a plan, not an observation' }));
	withFindings.finalise(['stop reason: step-limit']);

	const findings = readFileSync(path.join(dir, 'findings.md'), 'utf8');
	check('findings.md reports the defect', findings.includes('Save discards the form'));
	check('findings.md reports coverage even when there are findings', findings.includes('## Coverage'));
	check('coverage names the pages reached', findings.includes('https://example.com/broken'));
	check('coverage keeps the warning line', findings.includes('not evidence of health'));
	check('coverage counts the steps', findings.includes('2 steps reached 2 pages'));

	// --- the transcript explains itself -------------------------------------------
	const transcript = readFileSync(path.join(dir, 'run.jsonl'), 'utf8')
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line) as StepRecord);
	check('the transcript records the note that was kept', transcript[0]?.noteKept === 'The homepage lists two links.');
	check('the transcript records why one was dropped', transcript[1]?.noteIssue === 'a plan, not an observation');

	// --- a run that found nothing --------------------------------------------------
	const cleanDir = mkdtempSync(path.join(tmpdir(), 'artefacts-clean-'));
	try {
		const clean = new RunArtifacts(cleanDir, {
			url: 'https://example.com/',
			model: 'test-model',
			startedAt: '2026-01-01T00:00:00.000Z',
		});
		clean.addVisitedUrl('https://example.com/');
		clean.record(step({ step: 1 }));
		clean.finalise([]);
		const text = readFileSync(path.join(cleanDir, 'findings.md'), 'utf8');
		check('an empty run says so', text.includes('No defects were observed in this run'));
		check('an empty run still reports coverage', text.includes('## Coverage'));
	} finally {
		rmSync(cleanDir, { recursive: true, force: true });
	}
} finally {
	rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nartefact cases correct' : `\n${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
