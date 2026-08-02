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

Edit `~/Copix/settings.json`:

```json
{
  "model": {
    "provider": "groq",
    "apiKey": "gsk_…",
    "modelId": "llama-3.3-70b-versatile"
  }
}
```

Providers: `groq`, `openrouter`, `openai`, `ollama`.
