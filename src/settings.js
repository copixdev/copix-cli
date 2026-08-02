import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const COPIX_DIR = path.join(os.homedir(), 'Copix');
export const SETTINGS_PATH = path.join(COPIX_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
	model: {
		provider: 'ollama',
		apiKey: '',
		selection: 'auto',
		modelId: 'qwen2.5:3b',
		lowVram: false,
	},
	workspace: { homeDirectory: '' },
	agentMode: 'code',
};

const PROVIDER_DEFAULTS = {
	ollama: {
		baseUrl: 'http://127.0.0.1:11434/v1',
		model: 'qwen2.5:3b',
	},
	groq: {
		baseUrl: 'https://api.groq.com/openai/v1',
		model: 'llama-3.3-70b-versatile',
	},
	openrouter: {
		baseUrl: 'https://openrouter.ai/api/v1',
		model: 'anthropic/claude-sonnet-4',
	},
	openai: {
		baseUrl: 'https://api.openai.com/v1',
		model: 'gpt-4o',
	},
};

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
		const merged = {
			...DEFAULT_SETTINGS,
			...raw,
			model: {
				...DEFAULT_SETTINGS.model,
				...(raw.model || {}),
				// CLI uses local Ollama.
				provider: 'ollama',
			},
			workspace: { ...DEFAULT_SETTINGS.workspace, ...(raw.workspace || {}) },
		};
		const id = merged.model.modelId || DEFAULT_SETTINGS.model.modelId;
		if (/^(~?anthropic\/|openai\/|google\/|meta-llama\/|llama-3\.|gpt-|o3)/i.test(id)) {
			merged.model.modelId = DEFAULT_SETTINGS.model.modelId;
		}
		return merged;
	} catch {
		return structuredClone(DEFAULT_SETTINGS);
	}
}

export function resolveModelConfig(settings) {
	const provider = 'ollama';
	const defaults = PROVIDER_DEFAULTS.ollama;
	const model = settings.model?.modelId?.trim() || defaults.model;
	return {
		provider,
		model,
		baseUrl: defaults.baseUrl,
		apiKey: sanitizeApiKey(settings.model?.apiKey),
	};
}

export function buildHeaders(config) {
	return {
		'Content-Type': 'application/json',
		Authorization: 'Bearer ollama',
	};
}

export function settingsHint(_config) {
	return 'Start Ollama and pull a model: ollama pull qwen2.5:3b';
}
