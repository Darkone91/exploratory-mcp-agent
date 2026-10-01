/**
 * Configuration for the exploratory agent.
 *
 * Everything has a working default so `npm start -- --url <site>` is enough to
 * run. Real settings can come from `.env` (loaded by index.ts) or the CLI.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface Config {
	/** Where the exploration begins. */
	startUrl: string;
	/** Hard stop, so a confused model cannot loop forever on your GPU. */
	maxSteps: number;
	/** Ollama model tag. */
	model: string;
	/** Ollama base URL. */
	ollamaUrl: string;
	/** Headed is the default: watching the agent is the whole point. */
	headless: boolean;
	/**
	 * Browser the MCP server should drive.
	 *
	 * Not left to the server's default on purpose: that default is the *installed
	 * Chrome channel*, which absent a system Chrome fails with "Chromium
	 * distribution 'chrome' is not found". "chromium" uses the build that
	 * `playwright install chromium` put in the Playwright cache, so the project
	 * works on a machine with no browser pre-installed.
	 */
	browser: string;
	/** Per-run artefact directory. */
	runDir: string;
	/** Extra CLI args handed to the Playwright MCP server. */
	mcpArgs: string[];
	/**
	 * Hosts the agent may reach besides the application's own, for flows a host
	 * comparison cannot express - a login handed to an identity provider, or help
	 * that lives on its own domain. A bare host covers its subdomains.
	 */
	allowedHosts: string[];
}

function flagValue(argv: string[], name: string): string | undefined {
	const index = argv.indexOf(`--${name}`);
	if (index === -1) return undefined;
	const value = argv[index + 1];
	return value && !value.startsWith('--') ? value : undefined;
}

function flagOn(argv: string[], name: string): boolean {
	return argv.includes(`--${name}`);
}

/** Every value given for a repeatable flag, e.g. --allow-host a.example --allow-host b.example. */
function flagValues(argv: string[], name: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] !== `--${name}`) continue;
		const value = argv[index + 1];
		if (value && !value.startsWith('--')) values.push(value);
	}
	return values;
}

export function loadConfig(argv: string[], env: NodeJS.ProcessEnv): Config {
	const steps = Number(flagValue(argv, 'steps') ?? env.MAX_STEPS ?? 12);

	return {
		startUrl: flagValue(argv, 'url') ?? env.START_URL ?? '',
		maxSteps: Number.isFinite(steps) && steps > 0 ? Math.floor(steps) : 12,
		model: flagValue(argv, 'model') ?? env.OLLAMA_MODEL ?? 'qwen2.5:7b',
		ollamaUrl: (env.OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, ''),
		// Watching the agent work is the point, so the window is on unless the operator
		// asks for it to be hidden. This used to read `--headless ? true : !--headed`,
		// which made a hidden window the silent default - the opposite of what the
		// README, the --help text and the field comment above all said, and of what
		// anyone watching a terminal would notice. --headed is accepted as well, and
		// wins if both are given: the failure that matters is a window hidden by
		// accident, which nobody can see.
		headless: flagOn(argv, 'headless') && !flagOn(argv, 'headed'),
		browser: flagValue(argv, 'browser') ?? env.MCP_BROWSER ?? 'chromium',
		runDir: flagValue(argv, 'out') ?? path.join(ROOT, 'runs'),
		mcpArgs: (env.MCP_ARGS ?? '').split(' ').map((part) => part.trim()).filter(Boolean),
		allowedHosts: [...flagValues(argv, 'allow-host'), ...(env.ALLOWED_HOSTS ?? '').split(/[\s,]+/)]
			.map((host) => host.trim())
			.filter((host) => host !== ''),
	};
}
