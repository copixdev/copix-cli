/** Host platform helpers for Copix Studio (desktop + CLI). */

export type HostPlatform = 'darwin' | 'win32' | 'linux' | string;

let cached: HostPlatform | null = null;

export function getHostPlatform(): HostPlatform {
	if (cached) return cached;
	try {
		const g = globalThis as typeof globalThis & {
			copix?: { getPlatform?: () => string; platform?: string };
			window?: { copix?: { getPlatform?: () => string; platform?: string } };
		};
		const api = g.copix ?? g.window?.copix;
		const p = api?.getPlatform?.() ?? api?.platform;
		if (typeof p === 'string' && p) {
			cached = p;
			return cached;
		}
	} catch { /* fall through */ }
	if (typeof process !== 'undefined' && typeof process.platform === 'string') {
		cached = process.platform;
		return cached;
	}
	cached = 'darwin';
	return cached;
}

export function isMac(): boolean {
	return getHostPlatform() === 'darwin';
}

export function isWindows(): boolean {
	return getHostPlatform() === 'win32';
}

/** Display name for the integrated terminal shell. */
export function shellLabel(): string {
	if (isWindows()) return 'PowerShell';
	if (isMac()) return 'zsh';
	return 'bash';
}

/** Prompt prefix shown in the terminal (e.g. `workspace $`). */
export function shellPrompt(cwd: string): string {
	if (isWindows()) return `PS ${cwd}>`;
	const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
	const leaf = parts[parts.length - 1] || '~';
	return `${leaf} $`;
}

/** Example home path for settings placeholders / docs. */
export function homePathExample(): string {
	if (isWindows()) return 'C:\\Users\\{username}';
	return '/Users/{username}';
}

/** Example project path used in agent prompts. */
export function projectPathExample(name = 'my-app'): string {
	if (isWindows()) return `C:\\Users\\{username}\\${name}`;
	return `/Users/{username}/${name}`;
}
