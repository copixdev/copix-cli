/** Agent ↔ integrated terminal panel event bridge. */

export type AgentTerminalEvent =
	| { type: 'start'; streamId: string; command: string; cwd?: string }
	| { type: 'output'; streamId: string; chunk: string }
	| { type: 'end'; streamId: string; result: string };

type Listener = (event: AgentTerminalEvent) => void;

const listeners = new Set<Listener>();

export function subscribeAgentTerminal(listener: Listener): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

export function emitAgentTerminal(event: AgentTerminalEvent): void {
	for (const listener of listeners) listener(event);
}
