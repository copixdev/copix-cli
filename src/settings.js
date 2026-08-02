import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const COPIX_DIR = path.join(os.homedir(), 'Copix');
export const SETTINGS_PATH = path.join(COPIX_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
	model: {
		provider: 'groq',
		apiKey: '',
		selection: 'auto',
		modelId: 'llama-3.3-70b-versatile',
		lowVram: false,
	},
	workspace: { homeDirectory: '' },
	agentMode: 'code',
};

const PROVIDER_DEFAULTS = {
	groq: {
		baseUrl: 'https://api.groq.com/openai/v1',
		model: 'llama-3.3-70b-versatile',
	},
	openrouter: {
		baseUrl: 'https://openrouter.ai/api/v1',
		model: 'anthropic/claude-opus-4',
	},
	openai: {
		baseUrl: 'https://api.openai.com/v1',
		model: 'gpt-4o',
	},
	ollama: {
		baseUrl: 'http://127.0.0.1:11434/v1',
		model: 'qwen2.5:3b',
	},
};

function normalizeProvider(raw) {
	const p = String(raw || 'groq').trim().toLowerCase();
	if (p === 'openrouter' || p === 'openai' || p === 'ollama' || p === 'groq') return p;
	return 'groq';
}

function sanitizeApiKey(apiKey) {
	const key = apiKey?.trim();
	if (!key) return undefined;
	if (/gsk_YOUR_KEY_HERE/i.test(key)) return undefined;
	if (/^gsk_x+$/i.test(key)) return undefined;
	return key;
}

export function ensureSettings() {
	fs.mkdirSync(COPIX_DIR, { recursive: true });
	if (!fs.existsSync(SETTINGS_PATH)) {
		fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`, 'utf8');
	}
}

export function loadSettings() {
	ensureSettings();
	try {
		const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
		return {
			...DEFAULT_SETTINGS,
			...raw,
			model: { ...DEFAULT_SETTINGS.model, ...(raw.model || {}) },
			workspace: { ...DEFAULT_SETTINGS.workspace, ...(raw.workspace || {}) },
		};
	} catch {
		return structuredClone(DEFAULT_SETTINGS);
	}
}

export function resolveModelConfig(settings) {
	const provider = normalizeProvider(settings.model?.provider);
	const defaults = PROVIDER_DEFAULTS[provider];
	const model = settings.model?.modelId?.trim() || defaults.model;
	const apiKey = sanitizeApiKey(settings.model?.apiKey);
	return {
		provider,
		model,
		baseUrl: defaults.baseUrl,
		apiKey,
	};
}

export function buildHeaders(config) {
	if (config.provider === 'openrouter') {
		return {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${config.apiKey ?? ''}`,
			'HTTP-Referer': 'https://github.com/EJH-BAE/Copix',
			'X-Title': 'Copix CLI',
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

export function settingsHint(config) {
	if (config.provider === 'ollama') {
		return 'Start Ollama and pull a model, or set model.provider to groq/openrouter/openai in ~/Copix/settings.json';
	}
	const hints = {
		groq: 'free key at console.groq.com',
		openrouter: 'key at openrouter.ai/keys',
		openai: 'key at platform.openai.com/api-keys',
	};
	return `Add model.apiKey in ~/Copix/settings.json (${hints[config.provider]})`;
}
