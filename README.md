# Copix CLI

Standalone terminal coding agent for **macOS** and **Windows** — same tools as Copix Desktop (`create_project`, `edit_file`, `terminal`, `web_search`, `web_fetch`, …).

**No account.** Local [Ollama](https://ollama.com) only. Copix is free to use and proprietary — see [LICENSE.txt](../LICENSE.txt).

## Install

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/EJH-BAE/Copix/main/cli/install.sh | bash
```

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/EJH-BAE/Copix/main/cli/install.ps1 | iex
```

Requires **Node.js 18+**, **git**, and [Ollama](https://ollama.com).

```bash
ollama pull qwen2.5:3b
copix doctor
copix
```

Installs into `~/.copix` and puts `copix` on your PATH (`~/.local/bin`, or `%USERPROFILE%\.local\bin` on Windows).

## Usage

```bash
copix                         # interactive REPL
copix "explain package.json"  # one-shot
copix -p ~/sites "add a landing page"
copix doctor                  # Node · Ollama · models · paths
```

### Slash commands

| Command | Action |
| --- | --- |
| `/model [tag\|auto]` | Show models, or switch — `/model qwen2.5:3b` pins a tag, `/model auto` restores task routing |
| `/models` | List installed Ollama tags |
| `/pull <tag>` | Download a model (`ollama pull`) |
| `/cwd [path]` | Show or change the workspace (saved as the default) |
| `/status` | Ollama status, model, workspace, session info |
| `/doctor` | Environment check |
| `/history` | Recent agent sessions (synced with Desktop) |
| `/new` | Fresh conversation, keep the screen |
| `/clear` | Wipe screen + scrollback and start fresh |
| `/help` | Show help |
| `/exit` | Quit |

## Desktop sync

CLI conversations save to `~/Copix/sessions.json` in the same format Copix Desktop uses. Settings live in `~/Copix/settings.json`.

## Layout

| Path | Role |
| --- | --- |
| `cli/bin/copix.js` | Entry |
| `cli/src/*` | REPL / UI / Node API shim |
| `cli/agent/*` | Standalone agent runtime (no Desktop app required) |

## Settings

```json
{
  "model": {
    "provider": "ollama",
    "modelId": "qwen2.5:3b"
  }
}
```
