import type { AgentMode } from './agentModes.js';
import type { ModelSettings } from '../types.js';
import {
	FALLBACK_MODEL_ID,
	GROQ_FALLBACK_MODEL,
	GROQ_MODE_MODEL_PREFERENCE,
	GROQ_MODEL_FALLBACKS,
	GROQ_TASK_MODEL_PREFERENCE,
	MODE_MODEL_PREFERENCE,
	defaultCloudModel,
	normalizeProvider,
	sanitizeGroqModelId,
	TASK_MODEL_PREFERENCE,
	modelIsAvailable,
	type TaskKind,
} from './modelCatalog.js';

export type ModelSelectionMode = 'auto' | 'manual';

export type { TaskKind };

const INSPECT_RE = /\b(inspect|explain|review|describe|what does|how does|walk me through|understand|overview|summarize|look at|analyze|analyse|codespace|codebase|this folder|this project|tell me about)\b/i;
const DEBUG_RE = /\b(fix|debug|error|bug|broken|fail(?:s|ed|ing)?|issue|crash|exception|stack trace)\b/i;
const TERMINAL_RE = /\b(run|install|npm|pnpm|yarn|brew|git|terminal|command|execute|shell|build|test|compile)\b/i;
const IMPLEMENT_RE = /\b(create|implement|add feature|scaffold|new app|new project|new (python |js |ts )?script|write (a |me )?(new )?|build me|make (me |a |an )?|generate|enhance|improve|extend|update|modify|refactor|simulation|pygame)\b/i;
const CONTINUATION_RE = /^(yes|yeah|yep|yup|ok|okay|sure|go ahead|continue|proceed|do it|create|yes create|enhance|keep going|finish( it)?|complete( it)?|do that|make it|add that|go on|carry on|please do|do so)\.?!?\s*$/i;
const GREETING_RE = /^(hi|hello|hey|yo|sup|howdy|good (morning|afternoon|evening)|thanks|thank you|thx|hola|你好)\.?!?\s*$/i;
/** Short chat / small-talk — answer in text, never tools (especially not `terminal echo`). */
const SIMPLE_CHAT_RE = /^(hi|hello|hey|thanks|thank you|thx|ok|okay|yo|sup|howdy|hola|你好|good (morning|afternoon|evening)|how are you|what can you do|who are you|help)\b[\s!.?]*$/i;

export function isContinuationMessage(userMessage: string): boolean {
	return CONTINUATION_RE.test(userMessage.trim());
}

/** True for greetings / small talk that must stay tool-free. */
export function isSimpleChatMessage(userMessage: string): boolean {
	const msg = userMessage.trim();
	return !msg || GREETING_RE.test(msg) || SIMPLE_CHAT_RE.test(msg);
}

export function inferTaskKind(userMessage: string, agentMode: AgentMode): TaskKind {
	const msg = userMessage.trim();
	if (!msg) return agentMode === 'plan' ? 'plan' : agentMode === 'terminal' ? 'terminal' : 'general';
	if (GREETING_RE.test(msg)) return 'general';

	if (isContinuationMessage(msg)) {
		if (agentMode === 'debug') return 'debug';
		if (agentMode === 'terminal') return 'terminal';
		if (agentMode === 'plan') return 'plan';
		return 'implement';
	}

	if (INSPECT_RE.test(msg) && !IMPLEMENT_RE.test(msg)) return 'inspect';
	if (DEBUG_RE.test(msg)) return 'debug';
	if (TERMINAL_RE.test(msg) && !IMPLEMENT_RE.test(msg)) return 'terminal';
	if (IMPLEMENT_RE.test(msg)) return 'implement';
	if (agentMode === 'plan') return 'plan';
	if (agentMode === 'debug') return 'debug';
	if (agentMode === 'terminal') return 'terminal';
	if (agentMode === 'code') return 'implement';
	return 'general';
}

export function isReadOnlyTask(taskKind: TaskKind): boolean {
	return taskKind === 'inspect' || taskKind === 'plan';
}

export function normalizeModelSettings(model: ModelSettings): ModelSettings & { selection: ModelSelectionMode } {
	const selection = model.selection === 'manual' ? 'manual' : 'auto';
	return { ...model, selection };
}

function pickGroqModel(candidates: string[]): string {
	const seen = new Set<string>();
	for (const id of [...candidates, ...GROQ_MODEL_FALLBACKS, GROQ_FALLBACK_MODEL]) {
		if (seen.has(id)) continue;
		seen.add(id);
		return id;
	}
	return GROQ_FALLBACK_MODEL;
}

function pickOllamaModel(
	candidates: string[],
	installed: string[],
	lowVram: boolean,
	settingsModelId?: string,
): string {
	// Unknown install list — never stretch to models that may 404.
	if (installed.length === 0) {
		return settingsModelId?.trim() || FALLBACK_MODEL_ID;
	}

	const seen = new Set<string>();
	const ordered = lowVram
		? [...candidates, settingsModelId, 'qwen3.5:4b', FALLBACK_MODEL_ID]
		: [...candidates, settingsModelId, FALLBACK_MODEL_ID, 'qwen3.5:4b', 'qwen2.5-coder:7b', 'mistral:7b'];

	for (const id of ordered) {
		if (!id || seen.has(id)) continue;
		seen.add(id);
		if (modelIsAvailable(id, installed)) return id;
	}

	if (settingsModelId && modelIsAvailable(settingsModelId, installed)) return settingsModelId;
	if (modelIsAvailable(FALLBACK_MODEL_ID, installed)) return FALLBACK_MODEL_ID;
	return installed[0]!;
}

/** Pick the model tag for this agent turn. */
export function selectModelForTask(
	agentMode: AgentMode,
	settings: ModelSettings,
	installed: string[] = [],
	userMessage?: string,
): string {
	const normalized = normalizeModelSettings(settings);
	const provider = normalizeProvider(settings.provider);

	if (normalized.selection === 'manual') {
		const manual = normalized.modelId
			|| (provider === 'ollama' ? FALLBACK_MODEL_ID : defaultCloudModel(provider));
		if (provider === 'groq') return sanitizeGroqModelId(manual);
		if (provider === 'openrouter' || provider === 'openai') return manual;
		if (modelIsAvailable(manual, installed)) return manual;
		return modelIsAvailable(FALLBACK_MODEL_ID, installed) ? FALLBACK_MODEL_ID : manual;
	}

	const taskKind = userMessage ? inferTaskKind(userMessage, agentMode) : null;

	if (provider === 'openrouter' || provider === 'openai') {
		// One frontier model for all tasks — quality over routing tricks.
		return normalized.modelId || defaultCloudModel(provider);
	}

	if (provider === 'groq') {
		const preferred = taskKind
			? GROQ_TASK_MODEL_PREFERENCE[taskKind]
			: GROQ_MODE_MODEL_PREFERENCE[agentMode] ?? GROQ_FALLBACK_MODEL;
		return sanitizeGroqModelId(pickGroqModel([preferred, GROQ_FALLBACK_MODEL]));
	}

	const preferred = taskKind
		? TASK_MODEL_PREFERENCE[taskKind]
		: MODE_MODEL_PREFERENCE[agentMode] ?? FALLBACK_MODEL_ID;

	return pickOllamaModel(
		[preferred, normalized.modelId || FALLBACK_MODEL_ID],
		installed,
		Boolean(normalized.lowVram),
		normalized.modelId || FALLBACK_MODEL_ID,
	);
}

export function preferredModelForTask(
	agentMode: AgentMode,
	settings: ModelSettings,
	userMessage?: string,
): string {
	const provider = normalizeProvider(settings.provider);
	const taskKind = userMessage ? inferTaskKind(userMessage, agentMode) : null;
	if (provider === 'openrouter' || provider === 'openai') {
		return settings.modelId || defaultCloudModel(provider);
	}
	if (provider === 'groq') {
		const preferred = taskKind
			? GROQ_TASK_MODEL_PREFERENCE[taskKind]
			: GROQ_MODE_MODEL_PREFERENCE[agentMode] ?? GROQ_FALLBACK_MODEL;
		return sanitizeGroqModelId(preferred);
	}
	return taskKind
		? TASK_MODEL_PREFERENCE[taskKind]
		: MODE_MODEL_PREFERENCE[agentMode] ?? FALLBACK_MODEL_ID;
}

export function formatModelChipLabel(
	settings: ModelSettings,
	activeModel: string,
	opts?: { preferred?: string; installed?: string[] },
): string {
	const normalized = normalizeModelSettings(settings);
	const provider = normalizeProvider(settings.provider);
	const prefix = normalized.selection === 'manual' ? '' : 'auto · ';

	if (provider === 'groq') {
		return `${prefix}${sanitizeGroqModelId(activeModel)}`;
	}
	if (provider === 'openrouter' || provider === 'openai') {
		return `${prefix}${activeModel}`;
	}

	const preferred = opts?.preferred;
	const installed = opts?.installed ?? [];
	if (normalized.selection !== 'manual' && preferred && preferred !== activeModel && !modelIsAvailable(preferred, installed)) {
		return `${prefix}${activeModel} · pull ${preferred.split(':')[0]}`;
	}
	return `${prefix}${activeModel}`;
}
