/** Detect secrets / API keys that must never be treated as file paths. */

const SECRET_PATH_RE = [
	/^sk-[a-z0-9_-]{10,}/i,
	/^sk-or-v1-[a-f0-9]{20,}/i,
	/^gsk_[a-z0-9]{20,}/i,
	/^gh[pousr]_[a-zA-Z0-9]{20,}/,
	/^xox[baprs]-/i,
	/^AIza[0-9A-Za-z_-]{20,}/,
	/^ya29\.[0-9A-Za-z_-]+/,
	/^npm_[a-zA-Z0-9]{20,}/,
	/^hf_[a-zA-Z0-9]{20,}/,
];

export function looksLikeSecret(value: string): boolean {
	const raw = value.trim();
	if (!raw) return false;
	const base = raw.replace(/\\/g, '/').split('/').pop() || raw;
	const stem = base.replace(/\.[a-z0-9]{1,8}$/i, '');
	return SECRET_PATH_RE.some(re => re.test(stem) || re.test(base) || re.test(raw));
}

export function assertSafeFilePath(path: string): void {
	if (looksLikeSecret(path)) {
		throw new Error(
			'Refused: path looks like an API key or secret. Use a real project filename (e.g. rename_by_date.py), never paste keys into paths.',
		);
	}
	if (/^[a-z0-9_-]{40,}\.(py|ts|js|tsx|jsx|txt|md)$/i.test(path.replace(/\\/g, '/').split('/').pop() || '')) {
		// Long opaque hex/base64-like single-segment names are almost never intentional.
		const name = path.replace(/\\/g, '/').split('/').pop() || '';
		if (/^[a-f0-9_-]{48,}\./i.test(name) || /^sk-/i.test(name)) {
			throw new Error(
				`Refused suspicious filename "${name}". Choose a descriptive name like script.py.`,
			);
		}
	}
}

export function redactSecrets(text: string): string {
	return text
		.replace(/\bsk-or-v1-[a-f0-9]{20,}\b/gi, 'sk-or-v1-***')
		.replace(/\bsk-[a-zA-Z0-9_-]{20,}\b/g, 'sk-***')
		.replace(/\bgsk_[a-zA-Z0-9]{20,}\b/g, 'gsk_***');
}
