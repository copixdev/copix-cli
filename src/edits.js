/**
 * Undo stack for the last file edit in this CLI session.
 * The snapshot is taken in onToolStart, before the tool writes.
 */
import fs from 'node:fs';
import path from 'node:path';

const FILE_TOOLS = new Set(['write_file', 'edit_file', 'append_file', 'delete_file']);
const MAX_BYTES = 1_000_000;

export function resolveEditPath(filePath, workspaceRoot) {
	const target = String(filePath ?? '').trim();
	if (!target) return '';
	if (path.isAbsolute(target)) return path.normalize(target);
	if (!workspaceRoot) return '';
	return path.normalize(path.join(workspaceRoot, target));
}

export function snapshotFileEdit(tool, args, workspaceRoot, io = fs) {
	if (!FILE_TOOLS.has(String(tool || ''))) return null;
	const full = resolveEditPath(args?.path, workspaceRoot);
	if (!full) return null;
	try {
		const stat = io.statSync(full);
		if (!stat.isFile()) return null;
		if (stat.size > MAX_BYTES) return { path: full, existed: true, before: null, tooBig: true };
		return { path: full, existed: true, before: io.readFileSync(full), tooBig: false };
	} catch (err) {
		if (err && err.code === 'ENOENT') return { path: full, existed: false, before: null, tooBig: false };
		return null;
	}
}

export function applyUndo(entry, io = fs) {
	if (!entry) throw Object.assign(new Error('Nothing to undo.'), { code: 'ENOUNDO' });
	if (entry.tooBig) {
		throw Object.assign(new Error(`${entry.path} was too large to undo.`), { code: 'ETOOBIG' });
	}
	if (!entry.existed) {
		try {
			io.unlinkSync(entry.path);
		} catch (err) {
			if (err && err.code === 'ENOENT') return { action: 'removed', path: entry.path, missing: true };
			throw err;
		}
		return { action: 'removed', path: entry.path };
	}
	io.mkdirSync(path.dirname(entry.path), { recursive: true });
	io.writeFileSync(entry.path, entry.before);
	return { action: 'restored', path: entry.path };
}
