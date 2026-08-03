import type { CopixApi } from '../electron/preload';
import type { AppSettings } from './types';

declare global {
	interface Window {
		copix: CopixApi;
	}
	// eslint-disable-next-line no-var
	var copix: CopixApi | undefined;
}

function resolveCopixApi(): CopixApi | undefined {
	const g = globalThis as typeof globalThis & {
		copix?: CopixApi;
		window?: { copix?: CopixApi };
	};
	return g.copix ?? g.window?.copix;
}

function missingCopixApi(): never {
	const msg =
		'Copix API unavailable — reinstall the CLI: curl -fsSL https://raw.githubusercontent.com/EJH-BAE/Copix/main/cli/install.sh | bash  (Windows: irm .../cli/install.ps1 | iex)';
	console.error('[copix]', msg);
	throw new Error(msg);
}

/** Works in Electron renderer (window.copix) and Node CLI (globalThis.copix). */
export const copix: CopixApi = new Proxy({} as CopixApi, {
	get(_target, prop, receiver) {
		const api = resolveCopixApi();
		if (!api) {
			if (prop === 'platform') return 'darwin';
			return () => missingCopixApi();
		}
		const value = Reflect.get(api, prop, receiver);
		return typeof value === 'function' ? value.bind(api) : value;
	},
});

export async function loadSettings(): Promise<AppSettings | null> {
	return copix.getSettings() as Promise<AppSettings | null>;
}
