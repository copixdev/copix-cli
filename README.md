# Copix CLI

Terminal coding agent for Copix. Uses the same `~/Copix/settings.json` as the desktop apps.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/EJH-BAE/Copix/main/cli/install.sh | bash
```

Or from this repo:

```bash
chmod +x cli/bin/copix.js cli/install.sh
./cli/bin/copix.js --help
```

Requires Node.js 18+.

## Usage

```bash
copix                         # interactive REPL
copix "explain package.json"  # one-shot
copix -p ~/code/app "add tests"
```

## Settings

Uses local **Ollama** by default. Edit `~/Copix/settings.json` if you want a different model:

```json
{
  "model": {
    "provider": "ollama",
    "modelId": "qwen2.5:3b"
  }
}
```

```bash
ollama pull qwen2.5:3b
```
