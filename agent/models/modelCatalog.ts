import type { AgentMode } from './agentModes.js';

import type { ModelProvider } from '../types.js';

/** Always-available fallback when larger models are missing or low VRAM. */
export const FALLBACK_MODEL_ID = 'qwen2.5:3b';

/** Stretch-tier models Copix downloads and routes to by task (Ollama only). */
export const STRETCH_MODEL_IDS = [
	'qwen2.5-coder:7b',
	'mistral:7b',
	'qwen3.5:4b',
] as const;

/** Full set pulled on demand for Ollama (fallback pulled first on startup). */
export const COPIX_MODEL_IDS = [FALLBACK_MODEL_ID, ...STRETCH_MODEL_IDS] as const;

export type CopixModelId = (typeof COPIX_MODEL_IDS)[number];

export type TaskKind = 'inspect' | 'implement' | 'debug' | 'terminal' | 'plan' | 'general';

/** Ollama — preferred model per agent mode when selection is auto. */
export const MODE_MODEL_PREFERENCE: Record<AgentMode, CopixModelId | string> = {
	code: 'qwen2.5-coder:7b',
	debug: 'qwen3.5:4b',
	terminal: 'mistral:7b',
	plan: 'qwen3.5:4b',
};

export const TASK_MODEL_PREFERENCE: Record<TaskKind, string> = {
	inspect: 'qwen3.5:4b',
	plan: 'qwen3.5:4b',
	debug: 'qwen3.5:4b',
	implement: 'qwen2.5-coder:7b',
	terminal: 'mistral:7b',
	general: 'qwen3.5:4b',
};

/** Groq free tier — no download, instant (https://console.groq.com). */
export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

/** Free-tier friendly models (higher TPM / smaller requests). Avoid gpt-oss-120b on free — 8k TPM. */
export const GROQ_MODE_MODEL_PREFERENCE: Record<AgentMode, string> = {
	code: 'llama-3.3-70b-versatile',
	debug: 'llama-3.3-70b-versatile',
	terminal: 'llama-3.1-8b-instant',
	plan: 'llama-3.3-70b-versatile',
};

export const GROQ_TASK_MODEL_PREFERENCE: Record<TaskKind, string> = {
	inspect: 'llama-3.3-70b-versatile',
	plan: 'llama-3.3-70b-versatile',
	debug: 'llama-3.3-70b-versatile',
	implement: 'llama-3.3-70b-versatile',
	terminal: 'llama-3.1-8b-instant',
	general: 'llama-3.3-70b-versatile',
};

export const GROQ_FALLBACK_MODEL = 'llama-3.1-8b-instant';

/** Vision / image understanding (up to 5 images per request). */
export const GROQ_VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

/** Ordered fallbacks when preferred Groq model returns 404 / rate-limit / TPM errors.
 * Never include gpt-oss-120b on free tier — 8k TPM causes cascading 429s. */
export const GROQ_MODEL_FALLBACKS = [
	'llama-3.3-70b-versatile',
	'llama-3.1-8b-instant',
] as const;

/** Models that burn free-tier TPM too quickly — remap to a safe default. */
export const GROQ_BLOCKED_MODELS = [
	'openai/gpt-oss-120b',
	'openai/gpt-oss-20b',
	'gpt-oss-120b',
	'gpt-oss-20b',
] as const;

export function sanitizeGroqModelId(modelId: string): string {
	const id = modelId.trim();
	if (!id) return GROQ_FALLBACK_MODEL;
	if (GROQ_BLOCKED_MODELS.some(b => id === b || id.endsWith(`/${b}`) || id.includes('gpt-oss'))) {
		return 'llama-3.3-70b-versatile';
	}
	return id;
}

/** Free-tier TPM is tight — keep completion budget small so tools+prompt fit. */
export const GROQ_MAX_TOKENS = 1536;
export const GROQ_MAX_TOKENS_RETRY = 768;

/** OpenRouter — one paid key for frontier models (Claude Opus, GPT, Gemini). */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * OpenRouter reserves credits for the full max_tokens budget up-front.
 * Keep this modest so frontier models work on small balances; router retries lower on 402.
 */
export const OPENROUTER_MAX_TOKENS = 2048;
export const OPENROUTER_MAX_TOKENS_FLOOR = 512;

/** `~family-latest` aliases always resolve to the newest version on OpenRouter. */
export const OPENROUTER_DEFAULT_MODEL = '~anthropic/claude-sonnet-latest';

export const OPENROUTER_FEATURED_MODELS = [
	{ id: '~anthropic/claude-sonnet-latest', label: 'Claude Sonnet', detail: 'Latest · Balanced' },
	{ id: '~anthropic/claude-opus-latest', label: 'Claude Opus', detail: 'Latest · Best' },
	{ id: 'anthropic/claude-opus-5', label: 'Claude Opus 5', detail: 'Pinned' },
	{ id: 'openai/gpt-4o', label: 'GPT-4o', detail: 'OpenAI' },
	{ id: 'openai/gpt-4.1', label: 'GPT-4.1', detail: 'OpenAI' },
	{ id: 'openai/o3', label: 'o3', detail: 'Reasoning' },
	{ id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro', detail: 'Google' },
	{ id: 'meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B', detail: 'Cheap' },
] as const;

/** Parse OpenRouter "can only afford N" from a 402 body. */
export function parseOpenRouterAffordableTokens(message: string): number | undefined {
	const match = message.match(/can only afford\s+(\d+)/i);
	if (!match) return undefined;
	const n = Number(match[1]);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** Direct OpenAI API. */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_DEFAULT_MODEL = 'gpt-4o';

export const OPENAI_FEATURED_MODELS = [
	{ id: 'gpt-4o', label: 'GPT-4o', detail: 'Default' },
	{ id: 'gpt-4.1', label: 'GPT-4.1', detail: 'Coding' },
	{ id: 'o3', label: 'o3', detail: 'Reasoning' },
	{ id: 'gpt-4o-mini', label: 'GPT-4o mini', detail: 'Cheap' },
] as const;

/** Cloud providers that speak the OpenAI chat-completions protocol with a Bearer key. */
export const CLOUD_PROVIDERS: ReadonlySet<ModelProvider> = new Set(['groq', 'openrouter', 'openai']);

export function isCloudProvider(provider?: string): boolean {
	return CLOUD_PROVIDERS.has(normalizeProvider(provider));
}

export function defaultCloudModel(provider: ModelProvider): string {
	if (provider === 'openrouter') return OPENROUTER_DEFAULT_MODEL;
	if (provider === 'openai') return OPENAI_DEFAULT_MODEL;
	return GROQ_FALLBACK_MODEL;
}

export function normalizeProvider(provider?: string): ModelProvider {
	if (provider === 'groq') return 'groq';
	if (provider === 'openrouter') return 'openrouter';
	if (provider === 'openai') return 'openai';
	return 'ollama';
}

export function modelTagBase(modelId: string): string {
	return modelId.split(':')[0] ?? modelId;
}

/** True if Ollama tags list includes this model (any tag variant). */
export function modelIsAvailable(modelId: string, installed: string[]): boolean {
	if (!modelId || !installed.length) return false;
	const base = modelTagBase(modelId);
	return installed.some(name => {
		const normalized = name.trim();
		if (!normalized) return false;
		if (normalized === modelId) return true;
		if (normalized.startsWith(`${base}:`)) return true;
		if (normalized.startsWith(`${modelId}:`)) return true;
		if (!modelId.includes(':') && normalized.split(':')[0] === modelId) return true;
		return false;
	});
}

export function missingCopixModels(installed: string[]): string[] {
	return COPIX_MODEL_IDS.filter(id => !modelIsAvailable(id, installed));
}

/** Models to pull on startup — only the small fallback for fast launch. */
export function startupPullModels(installed: string[]): string[] {
	return modelIsAvailable(FALLBACK_MODEL_ID, installed) ? [] : [FALLBACK_MODEL_ID];
}
