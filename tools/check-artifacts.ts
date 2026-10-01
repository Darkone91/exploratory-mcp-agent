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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
		refused: null,
		overridden: null,
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
		promptVersion: 'test-v1',
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
	withFindings.record(
		step({
			step: 3,
			tool: 'browser_navigate',
			args: { url: 'http://169.254.169.254/' },
			refused: 'refused: 169.254.169.254 is not part of the application under test',
		}),
	);
	withFindings.finalise(['stop reason: step-limit']);

	const findings = readFileSync(path.join(dir, 'findings.md'), 'utf8');
	check('findings.md reports the defect', findings.includes('Save discards the form'));
	check('findings.md reports coverage even when there are findings', findings.includes('## Coverage'));
	check('coverage names the pages reached', findings.includes('https://example.com/broken'));
	check('coverage keeps the warning line', findings.includes('not evidence of health'));
	check('coverage counts the steps', findings.includes('3 steps reached 2 pages'));

	// --- the transcript explains itself -------------------------------------------
	const transcript = readFileSync(path.join(dir, 'run.jsonl'), 'utf8')
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line) as StepRecord);
	check('the transcript records the note that was kept', transcript[0]?.noteKept === 'The homepage lists two links.');
	check('the transcript records why one was dropped', transcript[1]?.noteIssue === 'a plan, not an observation');
	check(
		'the transcript records a step the harness refused',
		typeof transcript[2]?.refused === 'string' && transcript[2].refused !== '',
	);

	// --- a run that found nothing --------------------------------------------------
	const cleanDir = mkdtempSync(path.join(tmpdir(), 'artefacts-clean-'));
	try {
		const clean = new RunArtifacts(cleanDir, {
			url: 'https://example.com/',
			model: 'test-model',
			startedAt: '2026-01-01T00:00:00.000Z',
			promptVersion: 'test-v1',
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

	// --- a run that died before it recorded a step ---------------------------------
	// The loop writes its artefacts on the way out of a failed run, which is the one
	// moment nobody is watching the console. A run directory that holds three of its
	// four files would be a puzzle at exactly the wrong time.
	const deadDir = mkdtempSync(path.join(tmpdir(), 'artefacts-dead-'));
	try {
		const dead = new RunArtifacts(deadDir, {
			url: 'https://example.com/',
			model: 'test-model',
			startedAt: '2026-01-01T00:00:00.000Z',
			promptVersion: 'test-v1',
		});
		dead.finalise(['model calls: 0', 'stop reason: error']);
		for (const file of ['findings.md', 'app-guide.md', 'summary.json', 'run.jsonl']) {
			check(`a run that died before step one still writes ${file}`, existsSync(path.join(deadDir, file)));
		}
		const deadSummary = JSON.parse(readFileSync(path.join(deadDir, 'summary.json'), 'utf8')) as {
			lines?: string[];
			promptVersion?: string;
		};
		check(
			'and records how it stopped',
			deadSummary.lines?.includes('stop reason: error') === true,
		);
		check('and which prompt produced it', deadSummary.promptVersion === 'test-v1');
	} finally {
		rmSync(deadDir, { recursive: true, force: true });
	}

	// --- one observation, three wordings -------------------------------------------
	// The guide is built from notes, and a model working one page restates itself. The
	// exact-match version of this only caught the repetitions that were identical to the
	// character, which is the easy half; the threshold that decides the rest is measured
	// in check-notes.ts, and what is pinned here is that addNote reports the decision, so
	// the transcript can record it.
	const noteDir = mkdtempSync(path.join(tmpdir(), 'artefacts-notes-'));
	try {
		const notes = new RunArtifacts(noteDir, {
			url: 'https://example.com/',
			model: 'test-model',
			startedAt: '2026-01-01T00:00:00.000Z',
			promptVersion: 'test-v1',
		});
		check(
			'a note goes in the first time',
			notes.addNote('The first checkbox is now checked after clicking it.'),
		);
		check(
			'the same note in the same words is refused',
			!notes.addNote('The first checkbox is now checked after clicking it.'),
		);
		check(
			'the same observation in other words is refused too',
			!notes.addNote('The first checkbox is checked after it is clicked.'),
		);
		check(
			'a different observation on the same control is kept',
			notes.addNote('The second checkbox is now unchecked after clicking it.'),
		);
	} finally {
		rmSync(noteDir, { recursive: true, force: true });
	}
} finally {
	rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nartefact cases correct' : `\n${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
