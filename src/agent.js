import { buildHeaders, settingsHint } from './settings.js';
import { TOOL_DEFS, executeTool } from './tools.js';

const MAX_ROUNDS = 24;

function systemPrompt(workspaceRoot) {
	return [
		'You are Copix, a terminal coding agent.',
		'Work in the given workspace. Prefer tools over guessing.',
		'Be concise in chat. When editing code, use tools.',
		`Workspace: ${workspaceRoot}`,
		'Platform: ' + process.platform,
	].join('\n');
}

function printTool(name, args) {
	const preview = (() => {
		if (name === 'terminal') return String(args.command || '').slice(0, 120);
		if (args.path) return String(args.path);
		if (args.pattern) return String(args.pattern);
		return '';
	})();
	process.stdout.write(`\n\x1b[36m⚙ ${name}\x1b[0m${preview ? ` ${preview}` : ''}\n`);
}

function defaultMaxTokens(provider) {
	if (provider === 'openrouter') return 2048;
	if (provider === 'groq') return 1536;
	if (provider === 'openai') return 4096;
	return 2048;
}

async function chatCompletion(messages, config, { tools = true, maxTokens } = {}) {
	let tokens = maxTokens ?? defaultMaxTokens(config.provider);
	let lastError = '';

	for (let attempt = 0; attempt < 5; attempt++) {
		const body = {
			model: config.model,
			messages,
			temperature: 0.2,
			stream: false,
			max_tokens: tokens,
		};
		if (tools) body.tools = TOOL_DEFS;

		const res = await fetch(`${config.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: buildHeaders(config),
			body: JSON.stringify(body),
		});

		const text = await res.text();
		let data;
		try {
			data = JSON.parse(text);
		} catch {
			throw new Error(`${config.provider} returned non-JSON (${res.status}): ${text.slice(0, 240)}`);
		}

		if (!res.ok) {
			const msg = data?.error?.message || text.slice(0, 240);
			lastError = `${config.provider} ${res.status}: ${msg}`;
			if (res.status === 401 || /api key|unauthorized/i.test(msg)) {
				throw new Error(`${settingsHint(config)}\nAPI error: ${msg}`);
			}
			const afford = Number((msg.match(/can only afford\s+(\d+)/i) || [])[1]);
			const creditLimited = res.status === 402
				|| /requires more credits|can only afford|fewer max_tokens/i.test(msg);
			if (config.provider === 'openrouter' && creditLimited && Number.isFinite(afford) && afford > 0) {
				const next = Math.max(512, Math.min(tokens - 1, Math.floor(afford * 0.85)));
				if (next < tokens) {
					tokens = next;
					process.stdout.write(`\x1b[2m(OpenRouter credit reserve — retrying with max_tokens=${tokens}…)\x1b[0m\n`);
					continue;
				}
			}
			throw new Error(lastError);
		}

		const choice = data.choices?.[0]?.message;
		if (!choice) throw new Error(`${config.provider} returned no choices`);
		return choice;
	}

	throw new Error(lastError || `${config.provider} failed after retries`);
}

export async function runAgentTurn({ prompt, config, workspaceRoot, history }) {
	if (config.provider !== 'ollama' && !config.apiKey) {
		throw new Error(settingsHint(config));
	}

	const messages = [
		{ role: 'system', content: systemPrompt(workspaceRoot) },
		...history.slice(-16),
		{ role: 'user', content: prompt },
	];

	let finalText = '';

	for (let round = 0; round < MAX_ROUNDS; round++) {
		const choice = await chatCompletion(messages, config);
		const toolCalls = choice.tool_calls || [];
		const content = typeof choice.content === 'string' ? choice.content : '';

		if (!toolCalls.length) {
			if (content.trim()) {
				process.stdout.write(`\n${content.trim()}\n`);
				finalText = content.trim();
			} else if (!finalText) {
				process.stdout.write('\n(no reply)\n');
			}
			history.push({ role: 'user', content: prompt });
			if (finalText) history.push({ role: 'assistant', content: finalText });
			return finalText;
		}

		messages.push({
			role: 'assistant',
			content: content || '',
			tool_calls: toolCalls,
		});

		for (const call of toolCalls) {
			const name = call.function?.name || 'unknown';
			let args = {};
			try {
				args = JSON.parse(call.function?.arguments || '{}');
			} catch {
				args = {};
			}
			printTool(name, args);
			let result;
			try {
				result = await executeTool(name, args, workspaceRoot);
			} catch (err) {
				result = err instanceof Error ? err.message : String(err);
			}
			const clipped = String(result).slice(0, 24_000);
			process.stdout.write(`\x1b[2m${clipped.split('\n').slice(0, 8).join('\n')}${clipped.split('\n').length > 8 ? '\n…' : ''}\x1b[0m\n`);
			messages.push({
				role: 'tool',
				tool_call_id: call.id,
				name,
				content: clipped,
			});
		}
	}

	process.stdout.write('\nReached tool-round limit. Ask me to continue if needed.\n');
	history.push({ role: 'user', content: prompt });
	history.push({ role: 'assistant', content: finalText || '(tool limit)' });
	return finalText;
}
