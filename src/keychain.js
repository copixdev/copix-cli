/**
 * OpenRouter API key storage.
 * macOS Keychain, Windows Credential Manager, Linux Secret Service.
 * A new key is not written to settings.json. An existing plaintext key stays
 * there until a keychain write succeeds. Messages never include the key.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const KEYCHAIN_SERVICE = 'copix-openrouter';
export const KEYCHAIN_ACCOUNT = 'copix';
export const KEYRING_MISSING = 'No system keyring available. Set OPENROUTER_API_KEY in the environment.';
export const KEYRING_ENV = 'No system keyring available. Using OPENROUTER_API_KEY from the environment.';
export const KEYRING_WRITE_FAILED = 'Could not save the OpenRouter key to the system keychain. An existing settings key stays in place until that save succeeds.';

const KEYCHAIN_TIMEOUT_MS = 8000;

function envKey(env = process.env) {
	return String(env.OPENROUTER_API_KEY || '').trim();
}

function fallbackMessage(env) {
	return envKey(env) ? KEYRING_ENV : KEYRING_MISSING;
}

export function commandOnPath(bin, env = process.env, exists = fs.existsSync) {
	const raw = env.Path || env.PATH || '';
	const entries = String(raw).split(path.delimiter).filter(Boolean);
	const names = process.platform === 'win32' ? [`${bin}.cmd`, `${bin}.exe`, bin] : [bin];
	return entries.some((dir) => names.some((name) => {
		try {
			return exists(path.join(dir, name));
		} catch {
			return false;
		}
	}));
}

function defaultRun(bin, args, { input, timeoutMs = KEYCHAIN_TIMEOUT_MS, env } = {}) {
	return new Promise((resolve) => {
		let settled = false;
		const done = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		let proc;
		try {
			proc = spawn(bin, args, {
				stdio: ['pipe', 'pipe', 'pipe'],
				env: { ...process.env, ...(env || {}) },
			});
		} catch (err) {
			done({ code: 127, out: '', err: err instanceof Error ? err.message : String(err) });
			return;
		}
		let out = '';
		let err = '';
		const timer = setTimeout(() => {
			proc.kill();
			done({ code: 124, out, err: 'timeout' });
		}, timeoutMs);
		proc.stdout?.on('data', (chunk) => { out += chunk; });
		proc.stderr?.on('data', (chunk) => { err += chunk; });
		proc.on('error', (error) => done({ code: 127, out: '', err: error.message }));
		proc.on('close', (code) => done({ code: code ?? 1, out, err }));
		if (input != null) proc.stdin.end(input);
		else proc.stdin.end();
	});
}

async function linuxHasSecretTool(opts) {
	if (typeof opts.hasSecretTool === 'boolean') return opts.hasSecretTool;
	const run = opts.run || defaultRun;
	const res = await run('secret-tool', ['--version'], { timeoutMs: 2000 });
	return res.code === 0;
}

export async function keyringAvailable(opts = {}) {
	if (typeof opts.available === 'boolean') return opts.available;
	const platform = opts.platform || process.platform;
	const run = opts.run || defaultRun;
	if (platform === 'darwin') {
		const res = await run('security', ['help'], { timeoutMs: 2000 });
		return res.code !== 127;
	}
	if (platform === 'win32') {
		const res = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', 'exit 0'], { timeoutMs: 4000 });
		return res.code === 0;
	}
	if (platform === 'linux') return linuxHasSecretTool({ ...opts, run });
	return false;
}

const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$action = $env:COPIX_KEY_ACTION
$target = 'Copix OpenRouter'
Add-Type -Namespace CopixKey -Name Native -MemberDefinition @"
using System;
using System.Runtime.InteropServices;
public class Native {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public long LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 reservedFlag, out IntPtr credential);
  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr credential);
}
"@
if ($action -eq 'save') {
  $secret = [Console]::In.ReadToEnd()
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($secret)
  $ptr = [Runtime.InteropServices.Marshal]::AllocCoTaskMem($bytes.Length)
  [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $bytes.Length)
  $cred = New-Object CopixKey.Native+CREDENTIAL
  $cred.Type = 1
  $cred.TargetName = $target
  $cred.CredentialBlobSize = [uint32]$bytes.Length
  $cred.CredentialBlob = $ptr
  $cred.Persist = 2
  $cred.UserName = 'copix'
  $ok = [CopixKey.Native]::CredWrite([ref]$cred, 0)
  [Runtime.InteropServices.Marshal]::FreeCoTaskMem($ptr)
  if (-not $ok) { exit 1 }
  exit 0
}
$ptr = [IntPtr]::Zero
$ok = [CopixKey.Native]::CredRead($target, 1, 0, [ref]$ptr)
if (-not $ok) { exit 2 }
$cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][CopixKey.Native+CREDENTIAL])
$size = [int]$cred.CredentialBlobSize
if ($size -le 0) { [CopixKey.Native]::CredFree($ptr); exit 2 }
$bytes = New-Object byte[] $size
[Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $size)
[CopixKey.Native]::CredFree($ptr)
[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($bytes))
exit 0
`;

async function writeKey(secret, opts) {
	const platform = opts.platform || process.platform;
	const run = opts.run || defaultRun;
	if (platform === 'darwin') {
		// `-w` with no argument makes `security` read the password, then the
		// confirmation, from stdin. The key must not be an argv element, or
		// it shows up in `ps`.
		const res = await run('security', [
			'add-generic-password', '-U',
			'-s', KEYCHAIN_SERVICE,
			'-a', KEYCHAIN_ACCOUNT,
			'-w',
		], { input: `${secret}\n${secret}\n` });
		return res.code === 0;
	}
	if (platform === 'linux') {
		// secret-tool reads the secret from stdin, not argv.
		const res = await run('secret-tool', [
			'store', '--label=Copix OpenRouter',
			'service', KEYCHAIN_SERVICE,
			'account', KEYCHAIN_ACCOUNT,
		], { input: secret });
		return res.code === 0;
	}
	if (platform === 'win32') {
		// CredWrite reads the secret from stdin. It is not a process argument.
		const res = await run('powershell.exe', [
			'-NoLogo', '-NoProfile', '-Command', WINDOWS_SCRIPT,
		], { input: secret, env: { COPIX_KEY_ACTION: 'save' } });
		return res.code === 0;
	}
	return false;
}

async function readKey(opts) {
	const platform = opts.platform || process.platform;
	const run = opts.run || defaultRun;
	let res;
	if (platform === 'darwin') {
		res = await run('security', [
			'find-generic-password',
			'-s', KEYCHAIN_SERVICE,
			'-a', KEYCHAIN_ACCOUNT,
			'-w',
		]);
	} else if (platform === 'linux') {
		res = await run('secret-tool', [
			'lookup',
			'service', KEYCHAIN_SERVICE,
			'account', KEYCHAIN_ACCOUNT,
		]);
	} else if (platform === 'win32') {
		res = await run('powershell.exe', [
			'-NoLogo', '-NoProfile', '-Command', WINDOWS_SCRIPT,
		], { env: { COPIX_KEY_ACTION: 'load' } });
	} else {
		return '';
	}
	if (!res || res.code !== 0) return '';
	return String(res.out || '').replace(/\r?\n$/, '');
}

export async function loadOpenRouterKey(opts = {}) {
	const env = opts.env || process.env;
	const available = await keyringAvailable(opts);
	if (available) {
		try {
			const key = await readKey(opts);
			if (key) return { key, source: 'keychain', keyring: true, message: '' };
		} catch {
			/* fall through to the env var */
		}
	}
	const fromEnv = envKey(env);
	if (!available) {
		return {
			key: fromEnv,
			source: fromEnv ? 'env' : 'none',
			keyring: false,
			message: fallbackMessage(env),
		};
	}
	return { key: fromEnv, source: fromEnv ? 'env' : 'none', keyring: true, message: '' };
}

export async function saveOpenRouterKey(secret, opts = {}) {
	const value = String(secret || '');
	if (!value) return { ok: false, stored: false, message: '' };
	const env = opts.env || process.env;
	let available = false;
	try {
		available = await keyringAvailable(opts);
	} catch {
		available = false;
	}
	if (!available) {
		return { ok: false, stored: false, message: fallbackMessage(env) };
	}
	try {
		const ok = await writeKey(value, opts);
		if (!ok) return { ok: false, stored: false, message: KEYRING_WRITE_FAILED };
		return { ok: true, stored: true, message: '' };
	} catch {
		return { ok: false, stored: false, message: KEYRING_WRITE_FAILED };
	}
}

/** Settings written to disk. apiKey is always blank. */
export function settingsForDisk(settings) {
	const copy = JSON.parse(JSON.stringify(settings ?? {}));
	if (copy.model && typeof copy.model === 'object') copy.model.apiKey = '';
	return copy;
}

export function keyStatusLabel(key) {
	return String(key || '').trim() ? 'set' : 'not set';
}
