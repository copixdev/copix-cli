export interface LineDiffStats {
	added: number;
	removed: number;
	preview: string;
}

/** Simple line-based diff stats + compact preview for activity UI. */
export function computeLineDiff(before: string, after: string, maxLines = 12): LineDiffStats {
	const oldLines = before.split('\n');
	const newLines = after.split('\n');
	let added = 0;
	let removed = 0;
	const previewLines: string[] = [];

	// Myers-lite: count lines only in old / only in new (good enough for UI badge).
	const oldSet = new Map<string, number>();
	for (const l of oldLines) oldSet.set(l, (oldSet.get(l) ?? 0) + 1);
	const newSet = new Map<string, number>();
	for (const l of newLines) newSet.set(l, (newSet.get(l) ?? 0) + 1);

	for (const [line, count] of oldSet) {
		const n = newSet.get(line) ?? 0;
		if (count > n) removed += count - n;
	}
	for (const [line, count] of newSet) {
		const o = oldSet.get(line) ?? 0;
		if (count > o) added += count - o;
	}

	// Build a small unified-style preview from first changes.
	const maxLen = Math.max(oldLines.length, newLines.length);
	for (let i = 0; i < maxLen && previewLines.length < maxLines; i++) {
		const o = oldLines[i];
		const n = newLines[i];
		if (o === n) continue;
		if (o !== undefined && (n === undefined || o !== n)) {
			previewLines.push(`- ${o}`);
		}
		if (n !== undefined && (o === undefined || o !== n)) {
			previewLines.push(`+ ${n}`);
		}
	}

	if (!previewLines.length && before !== after) {
		previewLines.push('+ (file updated)');
	}

	return { added, removed, preview: previewLines.join('\n') };
}

export function truncateText(text: string, max = 2400): string {
	if (text.length <= max) return text;
	return text.slice(0, max) + '\n… (truncated)';
}
