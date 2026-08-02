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
| `/model [tag\|auto]` | Show models, or switch — `/model qwen2.5:3b` pins a tag, `/model auto` restores task routing (saved to `settings.json`) |
| `/models` | List installed Ollama tags |
| `/pull <tag>` | Download a model (`ollama pull`) |
| `/cwd [path]` | Show or change the workspace (saved as the default) |
| `/status` | Ollama status, model, workspace, session info |
| `/history` | Recent agent sessions (synced with Desktop) |
| `/new` | Fresh conversation, keep the screen |
| `/clear` | Wipe screen + scrollback and start fresh |
| `/help` | Show help |
| `/exit` | Quit |

The REPL mirrors Cursor Agent’s text UI:

- **Type inside the input box** — `→` prompt in a rounded rectangle
- **Slash menu** — type `/` for a filtered command list (↑↓ select, Tab complete, Enter run)
- `⬢` step timeline and tool cards while the agent works
- Missing Ollama models (e.g. `qwen2.5-coder:7b`) automatically fall back to `qwen2.5:3b`

### Desktop sync

CLI conversations are saved to `~/Copix/sessions.json` in the same format Copix Desktop uses. Desktop merges that file on launch and whenever its window regains focus, so agents you ran in the terminal appear in the Desktop sidebar (and Desktop history is mirrored back to the same file).

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
