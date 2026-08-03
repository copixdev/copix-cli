#!/usr/bin/env bash
# Copix CLI installer (macOS / Linux)
# curl -fsSL https://raw.githubusercontent.com/EJH-BAE/Copix/main/cli/install.sh | bash
set -euo pipefail

REPO="${COPIX_REPO:-https://github.com/EJH-BAE/Copix.git}"
BRANCH="${COPIX_BRANCH:-main}"
INSTALL_DIR="${COPIX_INSTALL_DIR:-$HOME/.copix}"
BIN_DIR="${COPIX_BIN_DIR:-$HOME/.local/bin}"

echo "Copix CLI — standalone installer (macOS / Linux)"
echo

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

if [ ! -f "$INSTALL_DIR/cli/agent/models/router.ts" ]; then
  echo "Install failed: standalone agent missing under cli/agent."
  exit 1
fi

echo "Installing CLI dependencies …"
npm install --prefix "$INSTALL_DIR/cli" --omit=dev --silent

ln -sfn "$INSTALL_DIR/cli/bin/copix.js" "$BIN_DIR/copix"
chmod +x "$INSTALL_DIR/cli/bin/copix.js" "$BIN_DIR/copix"

COPIX_HOME="${HOME}/Copix"
mkdir -p "$COPIX_HOME"
if [ ! -f "$COPIX_HOME/settings.json" ]; then
  cat > "$COPIX_HOME/settings.json" <<'JSON'
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
  SHELL_NAME="$(basename "${SHELL:-zsh}")"
  PROFILE=""
  case "$SHELL_NAME" in
    zsh) PROFILE="$HOME/.zshrc" ;;
    bash) PROFILE="$HOME/.bashrc" ;;
    *) PROFILE="$HOME/.profile" ;;
  esac
  echo
  echo "Add this to your shell profile ($PROFILE):"
  echo "  export PATH=\"$BIN_DIR:\$PATH\""
  echo
  echo "Then run:  source $PROFILE"
  echo "Or invoke directly:  $BIN_DIR/copix"
fi

echo
echo "No account required. Copix CLI talks to local Ollama."
echo
echo "Next:"
echo "  ollama pull qwen2.5:3b"
echo "  copix doctor"
echo "  copix"
echo "  copix \"summarize this repo\""
echo
echo "Windows install:"
echo "  irm https://raw.githubusercontent.com/EJH-BAE/Copix/main/cli/install.ps1 | iex"
