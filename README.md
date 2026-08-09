# Copix CLI

Standalone terminal coding agent for **macOS** and **Windows** — same tools as Copix Desktop (`create_project`, `edit_file`, `terminal`, `web_search`, `web_fetch`, …).

**No account.** Local [Ollama](https://ollama.com) only. The agent **creates and edits files for you** — it does not ask you to paste code into the project. Copix is open source (MIT) — see [LICENSE.txt](../LICENSE.txt).

Desktop installers: [`release/`](../release/) · [v4.3.0](https://github.com/EJH-BAE/Copix/releases/tag/v4.3.0).

## Install

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/EJH-BAE/Copix/refs/heads/main/cli/install.sh | bash
```

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/EJH-BAE/Copix/refs/heads/main/cli/install.ps1 | iex
```

Requires **Node.js 18+**, **git**, and [Ollama](https://ollama.com).

```bash
ollama pull qwen2.5:3b
copix doctor
copix
```

Installs into `~/.copix` and places a `copix` launcher on your **default PATH** (`/usr/local/bin`, or Homebrew’s bin / npm global when already writable). **Does not edit** `.zshrc` / `.bashrc`.

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

Default Copix home is the **OS user home**:

| OS | Default `workspace.homeDirectory` |
| --- | --- |
| macOS | `/Users/{username}` |
| Linux | `/home/{username}` |
| Windows | `C:\Users\{username}` |

`{username}` is expanded automatically. Empty string also means the real OS home.

```json
{
  "model": {
    "provider": "ollama",
    "modelId": "qwen2.5:3b"
  },
  "workspace": {
    "homeDirectory": "/Users/{username}"
  }
}
```

Preferences live in `~/Copix/settings.json`.