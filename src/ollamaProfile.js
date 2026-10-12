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

/** 8 GB class is anything under 12 GB (machines often report ~7.6–8). */
export function ramClass(totalBytes = os.totalmem()) {
	const gb = ramGb(totalBytes);
	if (gb < 12) return 8;
	if (gb < 24) return 16;
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

/**
 * 8 GB profile: Q4_K_M tag, num_ctx 4096, keep_alive 5m, never a second model.
 * Returns null on larger machines.
 */
export function eightGbDefaults(totalBytes = os.totalmem()) {
	if (ramClass(totalBytes) !== 8) return null;
	return {
		tag: 'qwen2.5:3b',
		quant: 'Q4_K_M',
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
