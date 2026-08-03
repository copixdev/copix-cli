/** panel chat activity rows (tool use, thinking, search). */

import type { LineDiffStats } from './utils/lineDiff';
import { looksLikeSecret } from './utils/secrets';

export type ActivityKind = 'read' | 'edit' | 'search' | 'browse' | 'think' | 'run' | 'list' | 'create' | 'multitask' | 'subagent';

export type ActivityPhase = 'active' | 'done';

export interface ChatActivity {
	id: string;
	kind: ActivityKind;
	phase: ActivityPhase;
	target?: string;
	/** Full path or raw target for detail panel */
	fullTarget?: string;
	detail?: string;
	result?: string;
	thought?: string;
	diff?: LineDiffStats;
	startedAt: number;
	endedAt?: number;
}

export interface ActivityDisplay {
	verb: string;
	target?: string;
	ellipsis?: boolean;
	commitBadge?: string;
}

export interface WorkflowSummary {
	durationMs: number;
	thoughtSec?: number;
	reads: number;
	searches: number;
	edits: number;
	runs: number;
	headline?: string;
	subtasks: Array<{ label: string; detail?: string; auto?: boolean }>;
}

export function isVisibleThought(activity: ChatActivity | undefined): boolean {
	if (!activity || activity.kind !== 'think') return false;
	const text = activity.thought?.trim() ?? '';
	return /rate limit|rate limited|tokens per minute|tpm|try again/i.test(text);
}

export function summarizeWorkflow(activities: ChatActivity[]): WorkflowSummary {
	if (!activities.length) {
		return { durationMs: 0, reads: 0, searches: 0, edits: 0, runs: 0, subtasks: [] };
	}
	const start = Math.min(...activities.map(a => a.startedAt));
	const end = Math.max(...activities.map(a => a.endedAt ?? Date.now()));
	const think = activities.find(a => a.kind === 'think');
	const visibleThink = isVisibleThought(think) ? think : undefined;
	const thoughtSec = think
		? Math.max(1, Math.round(((think.endedAt ?? Date.now()) - think.startedAt) / 1000))
		: undefined;

	const subtasks = activities
		.filter(a => a.kind !== 'think')
		.map(a => {
			const label = formatActivityDisplay(a);
			const text = [label.verb, label.target].filter(Boolean).join(' ');
			return {
				label: text,
				detail: a.phase === 'done' && a.detail ? truncate(a.detail.split('\n')[0] ?? '', 72) : undefined,
				auto: a.kind === 'search' || a.kind === 'read',
			};
		})
		.filter(t => t.label);

	return {
		durationMs: Math.max(end - start, 0),
		thoughtSec,
		reads: activities.filter(a => a.kind === 'read' && a.phase === 'done').length,
		searches: activities.filter(a => a.kind === 'search' && a.phase === 'done').length,
		edits: activities.filter(a => a.kind === 'edit' && a.phase === 'done').length,
		runs: activities.filter(a => a.kind === 'run' && a.phase === 'done').length,
		headline: visibleThink?.thought?.trim().split('\n').find(l => l.trim())?.trim(),
		subtasks: subtasks.slice(-6),
	};
}

const TOOL_KIND: Record<string, ActivityKind> = {
	read_file: 'read',
	write_file: 'edit',
	append_file: 'edit',
	edit_file: 'edit',
	delete_file: 'edit',
	grep: 'search',
	web_search: 'browse',
	web_fetch: 'browse',
	terminal: 'run',
	run_terminal: 'run',
	list_dir: 'list',
	create_project: 'create',
	multitask: 'multitask',
	spawn_subagent: 'subagent',
};

export function toolToKind(tool: string): ActivityKind {
	return TOOL_KIND[tool] ?? 'run';
}

export function extractTarget(tool: string, args: Record<string, unknown>): string | undefined {
	switch (tool) {
		case 'read_file':
		case 'write_file':
		case 'append_file':
		case 'edit_file':
		case 'delete_file':
		case 'list_dir':
			return args.path ? displayTarget(String(args.path)) : undefined;
		case 'grep':
			return args.pattern ? truncate(String(args.pattern), 56) : undefined;
		case 'web_search':
			return args.query ? truncate(String(args.query), 56) : undefined;
		case 'web_fetch':
			return args.url ? truncate(String(args.url), 56) : undefined;
		case 'terminal':
		case 'run_terminal':
			return args.command ? truncate(String(args.command), 56) : undefined;
		case 'create_project':
			return args.name ? String(args.name) : undefined;
		case 'multitask':
			return args.summary ? truncate(String(args.summary), 48) : 'parallel tasks';
		case 'spawn_subagent':
			return args.label ? truncate(String(args.label), 48) : 'subagent';
		default:
			return undefined;
	}
}

export function extractFullTarget(tool: string, args: Record<string, unknown>): string | undefined {
	switch (tool) {
		case 'read_file':
		case 'write_file':
		case 'append_file':
		case 'edit_file':
		case 'delete_file':
		case 'list_dir':
			return args.path ? String(args.path) : undefined;
		case 'grep':
			return args.pattern ? String(args.pattern) : undefined;
		case 'web_search':
			return args.query ? String(args.query) : undefined;
		case 'web_fetch':
			return args.url ? String(args.url) : undefined;
		case 'terminal':
		case 'run_terminal':
			return args.command ? String(args.command) : undefined;
		case 'multitask':
			return 'multitask';
		default:
			return undefined;
	}
}

export function displayTarget(raw: string): string {
	const norm = raw.replace(/\\/g, '/');
	const base = norm.split('/').pop() || norm;
	return truncate(base, 48);
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function formatActivityDisplay(activity: ChatActivity): ActivityDisplay {
	const target = activity.target;
	const commitBadge = activity.diff && activity.phase === 'done'
		? `+${activity.diff.added} -${activity.diff.removed}`
		: undefined;

	switch (activity.kind) {
		case 'read':
			return activity.phase === 'active'
				? { verb: 'Reading', target, ellipsis: true }
				: { verb: 'Read', target, commitBadge };
		case 'edit':
			return activity.phase === 'active'
				? { verb: 'Editing', target, ellipsis: true }
				: { verb: 'Edited', target, commitBadge };
		case 'search':
			return activity.phase === 'active'
				? { verb: 'Searching', target, ellipsis: true }
				: { verb: 'Searched', target };
		case 'browse':
			return activity.phase === 'active'
				? { verb: 'Browsing', target, ellipsis: true }
				: { verb: 'Browsed', target };
		case 'think': {
			if (activity.phase === 'active') {
				return isVisibleThought(activity)
					? { verb: 'Rate limited', ellipsis: true }
					: { verb: 'Thinking', ellipsis: true };
			}
			if (isVisibleThought(activity)) return { verb: 'Rate limited' };
			const ms = (activity.endedAt ?? Date.now()) - activity.startedAt;
			const sec = ms / 1000;
			const label = sec < 10 ? (Math.round(sec * 10) / 10).toFixed(sec < 1 ? 1 : 0) : String(Math.round(sec));
			return { verb: `Thought for ${label}s` };
		}
		case 'run':
			return activity.phase === 'active'
				? { verb: 'Running', target, ellipsis: true }
				: { verb: 'Ran', target };
		case 'list':
			return activity.phase === 'active'
				? { verb: 'Listing', target, ellipsis: true }
				: { verb: 'Listed', target };
		case 'create':
			return activity.phase === 'active'
				? { verb: 'Creating', target, ellipsis: true }
				: { verb: 'Created', target, commitBadge };
		case 'multitask':
			return activity.phase === 'active'
				? { verb: 'Multitasking', target, ellipsis: true }
				: { verb: 'Multitasked', target };
		case 'subagent':
			return activity.phase === 'active'
				? { verb: 'Spawning subagent', target, ellipsis: true }
				: { verb: 'Spawned subagent', target };
		default:
			return { verb: activity.phase === 'active' ? 'Working' : 'Done', target, ellipsis: activity.phase === 'active' };
	}
}

export function createThinkingActivity(id: string, seed?: string): ChatActivity {
	return { id, kind: 'think', phase: 'active', thought: seed, startedAt: Date.now() };
}

export function appendThinkingThought(activity: ChatActivity, chunk: string): ChatActivity {
	const clean = sanitizeThoughtChunk(chunk);
	if (!clean) return activity;
	const thought = (activity.thought ?? '') + clean;
	return { ...activity, thought: thought.slice(-1500) };
}

/** Keep reasoning text out of code blocks and implementation dumps. */
function sanitizeThoughtChunk(chunk: string): string {
	if (!chunk.trim()) return '';
	if (chunk.includes('```')) return '';
	if (/^\s*(import |from |def |class |function |const |let |var |#include|package )/m.test(chunk)) return '';
	if (chunk.split('\n').length > 4 && /[{}();]/.test(chunk)) return '';
	return chunk;
}

export function finalizeThinking(activity: ChatActivity, endedAt = Date.now()): ChatActivity {
	return { ...activity, phase: 'done', endedAt };
}

export function createToolActivity(
	id: string,
	tool: string,
	args: Record<string, unknown>,
): ChatActivity {
	const target = extractTarget(tool, args);
	const fullTarget = extractFullTarget(tool, args);
	const safeTarget = target && looksLikeSecret(target) ? '(blocked secret path)' : target;
	const safeFull = fullTarget && looksLikeSecret(fullTarget) ? undefined : fullTarget;
	return {
		id,
		kind: toolToKind(tool),
		phase: 'active',
		target: safeTarget,
		fullTarget: safeFull,
		startedAt: Date.now(),
	};
}

export interface FinalizeToolOptions {
	result?: string;
	diff?: LineDiffStats;
	detail?: string;
}

export function finalizeToolActivity(
	activity: ChatActivity,
	opts: FinalizeToolOptions = {},
	endedAt = Date.now(),
): ChatActivity {
	const result = opts.result ?? activity.result;
	let detail = opts.detail ?? activity.detail;

	if (!detail && result) {
		detail = buildDetailFromResult(activity.kind, activity.fullTarget, result, opts.diff);
	}

	return {
		...activity,
		phase: 'done',
		endedAt,
		result,
		diff: opts.diff ?? activity.diff,
		detail,
	};
}

function buildDetailFromResult(
	kind: ActivityKind,
	fullTarget: string | undefined,
	result: string,
	diff?: LineDiffStats,
): string {
	switch (kind) {
		case 'read':
			return fullTarget ? `Path: ${fullTarget}\n\n${result}` : result;
		case 'list':
			return fullTarget ? `Directory: ${fullTarget}\n\n${result}` : result;
		case 'search':
			return fullTarget ? `Pattern: ${fullTarget}\n\n${result}` : result;
		case 'edit':
			if (diff) {
				return `Path: ${fullTarget ?? '(unknown)'}\n${diff.preview}\n\nSaved.`;
			}
			return fullTarget ? `Updated ${fullTarget}` : 'File updated';
		case 'run':
			return result;
		case 'multitask':
			return result;
		default:
			return result;
	}
}

/** Static preview rows for UI development. */
export function createDemoActivities(): ChatActivity[] {
	const t = Date.now();
	return [
		{ id: 'demo-think', kind: 'think', phase: 'done', thought: 'Planning component structure…', startedAt: t - 2400, endedAt: t - 200 },
		{ id: 'demo-read', kind: 'read', phase: 'done', target: 'router.ts', fullTarget: 'src/models/router.ts', detail: 'export function runAgent…', startedAt: t - 180, endedAt: t - 120 },
		{ id: 'demo-edit', kind: 'edit', phase: 'done', target: 'ChatCenter.tsx', diff: { added: 12, removed: 3, preview: '- old line\n+ new line' }, startedAt: t - 60, endedAt: t - 10 },
		{ id: 'demo-search', kind: 'search', phase: 'done', target: 'onToolStart', startedAt: t - 300, endedAt: t - 250 },
	];
}
