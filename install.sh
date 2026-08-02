#!/usr/bin/env bash
set -euo pipefail

REPO="${COPIX_REPO:-https://github.com/EJH-BAE/Copix.git}"
BRANCH="${COPIX_BRANCH:-main}"
INSTALL_DIR="${COPIX_INSTALL_DIR:-$HOME/.copix}"
BIN_DIR="${COPIX_BIN_DIR:-$HOME/.local/bin}"

if ! command -v node >/dev/null 2>&1; then
  echo "Copix CLI requires Node.js 18+."
  echo "Install Node from https://nodejs.org and re-run this script."
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Copix CLI requires Node.js 18+ (found $(node -v))."
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git is required to install Copix CLI."
  exit 1
fi

mkdir -p "$INSTALL_DIR" "$BIN_DIR"

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Updating Copix in $INSTALL_DIR …"
  git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
else
  echo "Installing Copix into $INSTALL_DIR …"
  rm -rf "$INSTALL_DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$INSTALL_DIR"
fi

# Prefer sparse-ish layout: keep full clone but link the CLI entry.
ln -sfn "$INSTALL_DIR/cli/bin/copix.js" "$BIN_DIR/copix"
chmod +x "$INSTALL_DIR/cli/bin/copix.js" "$BIN_DIR/copix"

mkdir -p "$HOME/Copix"
if [ ! -f "$HOME/Copix/settings.json" ]; then
  cat > "$HOME/Copix/settings.json" <<'JSON'
{
  "model": {
    "provider": "groq",
    "apiKey": "",
    "selection": "auto",
    "modelId": "llama-3.3-70b-versatile",
    "lowVram": false
  },
  "workspace": { "homeDirectory": "" },
  "agentMode": "code"
}
JSON
fi

echo
echo "Installed: $BIN_DIR/copix"
if ! echo ":$PATH:" | grep -q ":$BIN_DIR:"; then
  echo
  echo "Add this to your shell profile (~/.bashrc or ~/.zshrc):"
  echo "  export PATH=\"$BIN_DIR:\$PATH\""
fi
echo
echo "Configure a provider key in ~/Copix/settings.json, then run:"
echo "  copix"
echo "  copix \"summarize this repo\""
