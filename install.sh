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

mkdir -p "$BIN_DIR"

install_or_update() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    echo "Updating Copix in $INSTALL_DIR …"
    # Throwaway install dir — always match origin exactly (handles diverged local history).
    git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH"
    git -C "$INSTALL_DIR" checkout -B "$BRANCH" "origin/$BRANCH"
    git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"
    git -C "$INSTALL_DIR" clean -fd
  else
    echo "Installing Copix into $INSTALL_DIR …"
    rm -rf "$INSTALL_DIR"
    git clone --depth 1 --branch "$BRANCH" "$REPO" "$INSTALL_DIR"
  fi
}

if ! install_or_update; then
  echo "Git update failed — re-cloning $INSTALL_DIR …"
  rm -rf "$INSTALL_DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$INSTALL_DIR"
fi

if [ ! -f "$INSTALL_DIR/cli/bin/copix.js" ]; then
  echo "Install failed: $INSTALL_DIR/cli/bin/copix.js missing."
  exit 1
fi

ln -sfn "$INSTALL_DIR/cli/bin/copix.js" "$BIN_DIR/copix"
chmod +x "$INSTALL_DIR/cli/bin/copix.js" "$BIN_DIR/copix"

mkdir -p "$HOME/Copix"
if [ ! -f "$HOME/Copix/settings.json" ]; then
  cat > "$HOME/Copix/settings.json" <<'JSON'
{
  "model": {
    "provider": "ollama",
    "apiKey": "",
    "selection": "auto",
    "modelId": "qwen2.5:3b",
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
  echo "Add this to your shell profile (~/.zshrc):"
  echo "  export PATH=\"$BIN_DIR:\$PATH\""
  echo
  echo "Then run:  source ~/.zshrc"
  echo "Or invoke directly:  $BIN_DIR/copix"
fi
echo
echo "Start Ollama, then run:"
echo "  ollama pull qwen2.5:3b"
echo "  copix"
echo "  copix \"summarize this repo\""
