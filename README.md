# Copix CLI

Terminal coding agent **synced with Copix Desktop** — same `runAgent` loop, system prompt, and tools (`create_project`, `edit_file`, `terminal`, `multitask`, `spawn_subagent`, …).

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/EJH-BAE/Copix/main/cli/install.sh | bash
```

Requires Node.js 18+ and [Ollama](https://ollama.com).

```bash
ollama pull qwen2.5:3b
export PATH="$HOME/.local/bin:$PATH"
copix
```

## Usage

```bash
copix                         # interactive REPL
copix "explain package.json"  # one-shot
copix -p ~/sites "add a landing page"
```

## How it syncs

| Piece | Source |
| --- | --- |
| Agent loop | `macOS/studio/src/models/router.ts` → `runAgent` |
| Tools | Desktop `TOOLS` / `executeTool` |
| Settings | `~/Copix/settings.json` (same as Desktop) |
| FS / shell | Node `CopixApi` shim (`cli/src/nodeApi.js`) |

## Settings

```json
{
  "model": {
    "provider": "ollama",
    "modelId": "qwen2.5:3b"
  }
}
```
