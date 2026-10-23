/**
 * RAM-based Ollama model choice.
 * 8 GB machines stay on one quantized model with a small context.
 */
import os from 'node:os';

const GB = 1024 ** 3;

export const MODELS = [
	{ tag: 'qwen2.5:3b', ram: 8, size: 'about 2 GB', quant: 'Q4_K_M' },
	{ tag: 'qwen2.5:7b', ram: 16, size: 'about 4.7 GB', quant: 'Q4_K_M' },
	{ tag: 'qwen2.5:14b', ram: 32, size: 'about 9 GB', quant: 'Q4_K_M' },
];

function ramGb(totalBytes = os.totalmem()) {
	const gb = Number(totalBytes) / GB;
	if (!Number.isFinite(gb) || gb < 0) return 0;
	return gb;
}

/**
 * RAM class follows recommendModel. Under 16 GB the fit is the 3B tag,
 * under 32 GB the 7B tag, and 32 GB and up the 14B tag.
 */
export function ramClass(totalBytes = os.totalmem()) {
	const ram = recommendModel(totalBytes).ram;
	if (ram <= 8) return 8;
	if (ram <= 16) return 16;
	return 32;
}

/** Largest tag whose RAM requirement fits. The smallest tag is the floor. */
export function recommendModel(totalBytes = os.totalmem()) {
	const gb = ramGb(totalBytes);
	let fit = MODELS[0];
	for (const model of MODELS) {
		if (gb >= model.ram) fit = model;
	}
	return fit;
}

export function recommendationLines(totalBytes = os.totalmem()) {
	const gb = ramGb(totalBytes);
	const model = recommendModel(totalBytes);
	const shown = Math.max(1, Math.floor(gb));
	const lines = [
		`Recommended for ${shown} GB: ${model.tag} (${model.size})`,
	];
	for (const other of MODELS) {
		if (other.tag === model.tag) continue;
		if (other.ram > gb) lines.push(`${other.tag} needs ${other.ram} GB`);
	}
	return lines;
}

/** Parameter size in billions from a tag such as `qwen2.5-coder:7b`. */
export function modelBillions(tag) {
	const match = String(tag || '').match(/(\d+(?:\.\d+)?)b\b/i);
	if (!match) return null;
	const value = Number(match[1]);
	return Number.isFinite(value) ? value : null;
}

/** True when `tag` is no larger than the model recommendModel would save. */
export function modelFitsTier(tag, totalBytes = os.totalmem()) {
	const cap = modelBillions(recommendModel(totalBytes).tag);
	if (cap == null) return true;
	const size = modelBillions(tag);
	if (size == null) return false;
	return size <= cap;
}

function tagInstalled(tag, installed) {
	const want = String(tag || '');
	if (!want) return false;
	return installed.some((name) => name === want || name.startsWith(`${want}:`));
}

/**
 * Installed tag Auto may call. A missing recommendation stays put so the
 * caller can ask for a pull. A larger installed tag is never a substitute.
 */
export function fitInstalledModel(selected, installed, totalBytes = os.totalmem()) {
	const list = Array.isArray(installed) ? installed.map(String) : [];
	const safe = recommendModel(totalBytes).tag;
	const chosen = String(selected || safe);
	if (modelFitsTier(chosen, totalBytes) && tagInstalled(chosen, list)) return chosen;
	if (tagInstalled(safe, list)) return safe;
	return safe;
}

/**
 * 3B profile: Q4_K_M tag, num_ctx 4096, keep_alive 5m, never a second model.
 * Applies whenever recommendModel is still qwen2.5:3b (under 16 GB).
 * Returns null once a larger tag fits.
 */
export function eightGbDefaults(totalBytes = os.totalmem()) {
	const model = recommendModel(totalBytes);
	if (model.tag !== 'qwen2.5:3b') return null;
	return {
		tag: model.tag,
		quant: model.quant,
		numCtx: 4096,
		keepAlive: '5m',
		singleModel: true,
	};
}

function sameModel(name, target) {
	const a = String(name || '');
	const b = String(target || '');
	if (!a || !b) return false;
	return a === b || a.startsWith(`${b}:`) || b.startsWith(`${a}:`);
}

/** Unload every loaded model except `target`. A dead Ollama returns quickly. */
export async function unloadOtherModels(target, fetchImpl = globalThis.fetch, timeoutMs = 1500) {
	let signal;
	try {
		signal = AbortSignal.timeout(timeoutMs);
	} catch {
		return;
	}
	try {
		const res = await fetchImpl('http://127.0.0.1:11434/api/ps', { signal });
		if (!res?.ok) return;
		const data = await res.json();
		const names = [];
		for (const entry of data?.models || []) {
			const name = String(entry?.name || entry?.model || '');
			if (!name || sameModel(name, target)) continue;
			names.push(name);
		}
		await Promise.all(names.map((name) => fetchImpl('http://127.0.0.1:11434/api/generate', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ model: name, keep_alive: 0 }),
			signal,
		}).catch(() => undefined)));
	} catch {
		return;
	}
}
