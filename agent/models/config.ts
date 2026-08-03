export const OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1';
export {
	FALLBACK_MODEL_ID as DEFAULT_MODEL_ID,
	COPIX_MODEL_IDS,
	GROQ_BASE_URL,
	GROQ_FALLBACK_MODEL,
	GROQ_VISION_MODEL,
} from './modelCatalog.js';
export type { ModelProvider } from '../types.js';

import type { AgentMode } from './agentModes.js';
import {
	FALLBACK_MODEL_ID, GROQ_BASE_URL, GROQ_MAX_TOKENS, GROQ_VISION_MODEL,
	OPENAI_BASE_URL, OPENAI_DEFAULT_MODEL, OPENROUTER_BASE_URL, OPENROUTER_DEFAULT_MODEL,
	OPENROUTER_MAX_TOKENS, normalizeProvider, sanitizeGroqModelId,
} from './modelCatalog.js';
import type { ModelProvider } from '../types.js';
import { selectModelForTask } from './modelSelector.js';
import type { ModelSettings } from '../types.js';

export const DEFAULT_NUM_CTX = 16384;
export const LOW_VRAM_NUM_CTX = 8192;
export const DEFAULT_NUM_PREDICT = 16384;
export const LOW_VRAM_NUM_PREDICT = 8192;

/** Strip whitespace and reject placeholder keys from defaults / docs. */
export function sanitizeApiKey(apiKey?: string): string | undefined {
	const key = apiKey?.trim();
	if (!key) return undefined;
	if (/gsk_YOUR_KEY_HERE/i.test(key)) return undefined;
	if (/^gsk_x+$/i.test(key)) return undefined;
	return key;
}

export interface ModelConfig {
	model: string;
	baseUrl: string;
	provider: ModelProvider;
	apiKey?: string;
	numCtx?: number;
	numPredict?: number;
	numGpu?: number;
}

export function settingsToConfig(model: ModelSettings, modelId?: string): ModelConfig {
	const provider = normalizeProvider(model.provider);
	let resolved = modelId ?? (model.modelId || FALLBACK_MODEL_ID);
	if (provider === 'groq') resolved = sanitizeGroqModelId(resolved);

	if (provider === 'groq') {
		return {
			model: resolved,
			baseUrl: GROQ_BASE_URL,
			provider: 'groq',
			apiKey: sanitizeApiKey(model.apiKey),
			numPredict: GROQ_MAX_TOKENS,
		};
	}

	if (provider === 'openrouter') {
		return {
			model: modelId ?? (model.modelId || OPENROUTER_DEFAULT_MODEL),
			baseUrl: OPENROUTER_BASE_URL,
			provider: 'openrouter',
			apiKey: sanitizeApiKey(model.apiKey),
			// OpenRouter pre-reserves credits for max_tokens — keep budget modest.
			numPredict: OPENROUTER_MAX_TOKENS,
		};
	}

	if (provider === 'openai') {
		return {
			model: modelId ?? (model.modelId || OPENAI_DEFAULT_MODEL),
			baseUrl: OPENAI_BASE_URL,
			provider: 'openai',
			apiKey: sanitizeApiKey(model.apiKey),
			numPredict: 4096,
		};
	}

	const lowVram = Boolean(model.lowVram);
	return {
		model: resolved,
		baseUrl: OLLAMA_BASE_URL,
		provider: 'ollama',
		numCtx: lowVram ? LOW_VRAM_NUM_CTX : DEFAULT_NUM_CTX,
		numPredict: lowVram ? LOW_VRAM_NUM_PREDICT : DEFAULT_NUM_PREDICT,
		numGpu: undefined,
	};
}

export function resolveModelConfig(
	model: ModelSettings,
	agentMode: AgentMode,
	installed: string[] = [],
	userMessage?: string,
	opts?: { hasImages?: boolean },
): ModelConfig {
	let modelId = selectModelForTask(agentMode, model, installed, userMessage);
	const provider = normalizeProvider(model.provider);
	if (opts?.hasImages && provider === 'groq') {
		modelId = GROQ_VISION_MODEL;
	}
	return settingsToConfig(model, modelId);
}

export function resolveChatUrl(config: ModelConfig): string {
	return `${config.baseUrl}/chat/completions`;
}

export function buildModelHeaders(config: ModelConfig): Record<string, string> {
	if (config.provider === 'openrouter') {
		return {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${config.apiKey ?? ''}`,
			'HTTP-Referer': 'https://github.com/EJH-BAE/Copix',
			'X-Title': 'Copix Studio',
		};
	}
	if (config.provider === 'groq' || config.provider === 'openai') {
		return {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${config.apiKey ?? ''}`,
		};
	}
	return {
		'Content-Type': 'application/json',
		Authorization: 'Bearer ollama',
	};
}

export function providerLabel(config: ModelConfig): string {
	return config.provider === 'ollama' ? 'ollama' : config.provider;
}

const CLOUD_KEY_HINTS: Record<string, string> = {
	groq: 'free key at console.groq.com',
	openrouter: 'key at openrouter.ai/keys (unlocks Claude Opus, GPT, Gemini)',
	openai: 'key at platform.openai.com/api-keys',
};

export async function checkModelHealth(config: ModelConfig): Promise<{ ok: boolean; message: string }> {
	if (config.provider !== 'ollama') {
		const label = config.provider === 'groq' ? 'Groq' : config.provider === 'openrouter' ? 'OpenRouter' : 'OpenAI';
		if (!config.apiKey) {
			return { ok: false, message: `Add model.apiKey in ~/Copix/settings.json (${CLOUD_KEY_HINTS[config.provider]})` };
		}
		try {
			const res = await fetch(`${config.baseUrl}/models`, {
				headers: buildModelHeaders(config),
				signal: AbortSignal.timeout(5000),
			});
			if (res.ok) return { ok: true, message: `${label} · ${config.model} ready` };
			return { ok: false, message: `${label} ${res.status} — check apiKey in settings.json` };
		} catch {
			return { ok: false, message: `Cannot reach ${label} — check network and apiKey` };
		}
	}

	try {
		const base = config.baseUrl.replace(/\/v1$/, '');
		const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(4000) });
		if (!res.ok) return { ok: false, message: `Ollama returned ${res.status}` };
		const data = await res.json() as { models?: Array<{ name: string }> };
		const names = (data.models ?? []).map(m => m.name);
		const has = names.some(n => n.startsWith(config.model) || n.startsWith(config.model.split(':')[0]));
		if (has) return { ok: true, message: `Ollama · ${config.model} ready` };
		return { ok: false, message: `Model ${config.model} not pulled — run ollama pull ${config.model}` };
	} catch {
		return { ok: false, message: 'Ollama offline — install from ollama.com, then run ollama pull qwen2.5:3b' };
	}
}
