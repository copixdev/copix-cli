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

### Slash commands

| Command | Action |
| --- | --- |
| `/help` | Show help |
| `/model` | Active model + installed Ollama tags |
| `/cwd` | Print workspace |
| `/clear` | Clear chat history |
| `/exit` | Quit |

The REPL mirrors Cursor Agent’s text UI: Question cards, `⬢` step timeline, `→` prompt, and a footer with mode / model / shortcuts. Missing Ollama models (e.g. `qwen2.5-coder:7b`) automatically fall back to `qwen2.5:3b`.

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
