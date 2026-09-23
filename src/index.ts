/**
 * CLI entry point.
 *
 *   npm start -- --url https://example.com --steps 15
 *
 * Pre-flight is deliberate: if Ollama is down or the model was never pulled, say
 * so clearly and stop, rather than spawning a browser and failing on step one
 * with a confusing error.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { explore } from './agent/loop.js';
import { ROOT, loadConfig } from './config.js';
import { listModels, OllamaUnavailableError } from './llm/ollama.js';
import { colour, log } from './util/log.js';

function loadDotEnv(): void {
	const envPath = path.join(ROOT, '.env');
	if (!existsSync(envPath)) return;
	try {
		process.loadEnvFile(envPath);
	} catch {
		log.warn('.env exists but could not be parsed; continuing with the real environment');
	}
}

function usage(): void {
	console.log(`
${colour.bold('exploratory-mcp-agent')} - an autonomous exploratory tester.

  npm start -- --url <url> [options]

Options
  --url <url>        Application to explore (required, or set START_URL).
  --steps <n>        Maximum actions before stopping.            default 12
  --model <tag>      Ollama model.                       default qwen2.5:7b
  --headed           Show the browser window (this is the default).
  --headless         Hide it. Useful in CI, useless for watching.
  --out <dir>        Parent directory for run output.        default ./runs
  --help             This text.

Output
  Each run writes a timestamped folder containing:
    findings.md      defects and risks, by severity
    app-guide.md     how the application works, and the path taken
    run.jsonl        the raw transcript, one JSON object per step
    summary.json     counts and timings
`);
}

/** Filesystem-safe timestamp, e.g. 2026-09-23T15-45-02. */
function runStamp(): string {
	return new Date().toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-');
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv.includes('--help') || argv.includes('-h')) {
		usage();
		return;
	}

	loadDotEnv();
	const base = loadConfig(argv, process.env);

	if (base.startUrl === '') {
		log.err('No target. Pass --url <url>, or set START_URL in .env.');
		usage();
		process.exitCode = 1;
		return;
	}

	log.head('Pre-flight');

	let models: string[];
	try {
		models = await listModels(base.ollamaUrl);
	} catch (error) {
		log.err(error instanceof OllamaUnavailableError ? error.message : String(error));
		process.exitCode = 1;
		return;
	}

	if (models.length === 0) {
		log.err('Ollama is running but has no models. Pull one first: ollama pull qwen2.5:7b');
		process.exitCode = 1;
		return;
	}

	if (!models.some((name) => name === base.model || name.startsWith(`${base.model}:`))) {
		// Fatal rather than a warning. Ollama does not pull a model on demand, so
		// continuing means launching a browser and then dying on step one with a 404
		// - which is both slower to diagnose and worse to read.
		log.err(`"${base.model}" is not available on this Ollama. Pull it first:`);
		log.info(`ollama pull ${base.model}`);
		log.info(`Available: ${models.join(', ')}`);
		process.exitCode = 1;
		return;
	}

	const config = { ...base, runDir: path.join(base.runDir, runStamp()) };
	log.ok(`target ${colour.cyan(config.startUrl)}`);

	try {
		await explore(config, new Date().toISOString());
	} catch (error) {
		log.err(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

await main();
