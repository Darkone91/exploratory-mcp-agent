/**
 * Ollama chat client.
 *
 * Deliberately small: one endpoint, no SDK dependency. The agent asks for JSON
 * (`format: 'json'`) because a 7B model is far more reliable when the runtime
 * constrains the output than when a prompt politely requests it.
 */

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface ChatStats {
	promptTokens: number;
	outputTokens: number;
	/** Wall-clock time for the whole call, ms. */
	totalMs: number;
	/** Time spent reading the prompt vs writing the answer. */
	promptMs: number;
	outputMs: number;
}

export interface ChatResult {
	content: string;
	stats: ChatStats;
}

export interface ChatOptions {
	baseUrl: string;
	model: string;
	temperature?: number;
	/** Upper bound on generated tokens. */
	maxTokens?: number;
	/** Ask Ollama to guarantee syntactically valid JSON. */
	json?: boolean;
	signal?: AbortSignal;
}

export class OllamaUnavailableError extends Error {
	constructor(baseUrl: string, cause: unknown) {
		super(
			`Could not reach Ollama at ${baseUrl}. Start it with "ollama serve", or install it from https://ollama.com/download.\n` +
				`If it listens somewhere else, set OLLAMA_URL in .env.\n` +
				`(${cause instanceof Error ? cause.message : String(cause)})`,
		);
		this.name = 'OllamaUnavailableError';
	}
}

interface OllamaChatResponse {
	message?: { content?: string };
	prompt_eval_count?: number;
	eval_count?: number;
	total_duration?: number;
	prompt_eval_duration?: number;
	eval_duration?: number;
}

const nsToMs = (value: number | undefined): number => Math.round((value ?? 0) / 1_000_000);

export async function chat(messages: ChatMessage[], options: ChatOptions): Promise<ChatResult> {
	let response: Response;
	try {
		response = await fetch(`${options.baseUrl}/api/chat`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			signal: options.signal,
			body: JSON.stringify({
				model: options.model,
				messages,
				stream: false,
				// Ollama's structured-output switch: the decoder is constrained, so
				// the reply parses even when the model rambles.
				...(options.json ? { format: 'json' } : {}),
				options: {
					temperature: options.temperature ?? 0.2,
					num_predict: options.maxTokens ?? 600,
				},
			}),
		});
	} catch (error) {
		throw new OllamaUnavailableError(options.baseUrl, error);
	}

	if (!response.ok) {
		throw new Error(`Ollama returned ${response.status} ${response.statusText}: ${await response.text()}`);
	}

	const payload = (await response.json()) as OllamaChatResponse;

	return {
		content: payload.message?.content ?? '',
		stats: {
			promptTokens: payload.prompt_eval_count ?? 0,
			outputTokens: payload.eval_count ?? 0,
			totalMs: nsToMs(payload.total_duration),
			promptMs: nsToMs(payload.prompt_eval_duration),
			outputMs: nsToMs(payload.eval_duration),
		},
	};
}

/** Cheap pre-flight: fail before spawning a browser if the server is not up. */
export async function listModels(baseUrl: string): Promise<string[]> {
	const response = await fetch(`${baseUrl}/api/tags`).catch((error) => {
		throw new OllamaUnavailableError(baseUrl, error);
	});
	if (!response.ok) throw new Error(`Ollama /api/tags returned ${response.status}`);
	const payload = (await response.json()) as { models?: { name?: string }[] };
	return (payload.models ?? []).map((model) => model.name ?? '').filter(Boolean);
}
