/**
 * Playwright MCP client.
 *
 * We are the MCP *client*; `@playwright/mcp` is the server, spawned as a child
 * process over stdio. That split is the point of the exercise: the browser lives
 * in the server, the reasoning lives here, and the boundary between them is a
 * documented protocol rather than a pile of selectors.
 *
 * The server exposes ~60 tools across several opt-in capabilities. Handing all of
 * them to a 7B model would burn most of the context window on tool schemas it
 * will never use, so `CURATED_TOOLS` narrows the surface to the ones an
 * exploratory run actually needs. Everything else stays available to humans via
 * the MCP inspector.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { ROOT } from '../config.js';

/**
 * Tools the agent may call, in the order they are described to the model.
 * Curated for breadth of exploration, not exhaustiveness.
 */
export const CURATED_TOOLS = [
	'browser_snapshot',
	'browser_find',
	'browser_navigate',
	'browser_navigate_back',
	'browser_click',
	'browser_type',
	'browser_select_option',
	'browser_press_key',
	'browser_wait_for',
	'browser_console_messages',
	'browser_generate_locator',
] as const;

export interface McpToolInfo {
	name: string;
	description: string;
}

export interface ToolCallResult {
	/** Flattened text output of the tool. */
	text: string;
	isError: boolean;
	/** Wall-clock duration, ms. */
	ms: number;
}

interface ContentPart {
	type?: string;
	text?: string;
}

function toText(content: unknown): string {
	if (!Array.isArray(content)) return '';
	const parts: string[] = [];
	for (const raw of content as ContentPart[]) {
		if (raw?.type === 'text' && typeof raw.text === 'string') parts.push(raw.text);
		// Non-text parts (images) are ignored on purpose: the design keeps the
		// model on the accessibility tree, so a stray screenshot cannot silently
		// blow up the prompt with base64.
	}
	return parts.join('\n').trim();
}

/** Resolve the MCP server entry point that npm installed next to us. */
function serverEntry(): string {
	const candidate = path.join(ROOT, 'node_modules', '@playwright', 'mcp', 'cli.js');
	if (!existsSync(candidate)) {
		throw new Error(
			`Playwright MCP server not found at ${candidate}. Run "npm install" first.`,
		);
	}
	return candidate;
}

export class BrowserSession {
	private constructor(
		private readonly client: Client,
		private readonly transport: StdioClientTransport,
		private readonly toolsByName: Map<string, McpToolInfo>,
	) {}

	static async start(options: {
		headless: boolean;
		browser: string;
		extraArgs?: string[];
	}): Promise<BrowserSession> {
		const args = [
			serverEntry(),
			// Isolated keeps runs reproducible: no leftover cookies or logins from a
			// previous session can change what the agent sees.
			'--isolated',
			options.headless ? '--headless' : '--headed',
			// Without this the server looks for a system Chrome and refuses to start.
			'--browser',
			options.browser,
			// Enables browser_generate_locator, which turns a discovered element into
			// a real Playwright locator - the bridge from exploration to a test.
			'--caps=testing',
			...(options.extraArgs ?? []),
		];

		const transport = new StdioClientTransport({
			command: process.execPath,
			args,
			env: { ...process.env } as Record<string, string>,
			stderr: 'pipe',
		});

		const client = new Client({ name: 'exploratory-mcp-agent', version: '0.1.0' });
		await client.connect(transport);

		const listed = await client.listTools();
		const toolsByName = new Map<string, McpToolInfo>(
			(listed.tools ?? []).map((tool) => [
				tool.name,
				{ name: tool.name, description: (tool.description ?? '').split('\n')[0] ?? '' },
			]),
		);

		return new BrowserSession(client, transport, toolsByName);
	}

	/** Curated tools that this server build actually exposes. */
	availableTools(): McpToolInfo[] {
		return CURATED_TOOLS.map((name) => this.toolsByName.get(name)).filter(
			(tool): tool is McpToolInfo => tool !== undefined,
		);
	}

	async call(tool: string, args: Record<string, unknown>): Promise<ToolCallResult> {
		const started = Date.now();
		try {
			const result = (await this.client.callTool({ name: tool, arguments: args })) as {
				content?: unknown;
				isError?: boolean;
			};
			return {
				text: toText(result.content),
				isError: result.isError === true,
				ms: Date.now() - started,
			};
		} catch (error) {
			// A tool throwing is information, not a crash: the model gets to read
			// the failure and try something else, exactly like a human would.
			return {
				text: `tool failed: ${error instanceof Error ? error.message : String(error)}`,
				isError: true,
				ms: Date.now() - started,
			};
		}
	}

	async close(): Promise<void> {
		await this.client.close().catch(() => undefined);
		await this.transport.close().catch(() => undefined);
	}
}
