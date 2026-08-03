#!/usr/bin/env bash
# Copix CLI installer (macOS / Linux) — permanent install, no manual PATH edits.
# curl -fsSL https://raw.githubusercontent.com/EJH-BAE/Copix/main/cli/install.sh | bash
set -euo pipefail

REPO="${COPIX_REPO:-https://github.com/EJH-BAE/Copix.git}"
BRANCH="${COPIX_BRANCH:-main}"
INSTALL_DIR="${COPIX_INSTALL_DIR:-$HOME/.copix}"
PATH_MARKER="# Copix CLI"
PATH_LINE_PREFIX='export PATH="'

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

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required to install Copix CLI (comes with Node.js)."
  exit 1
fi

install_or_update() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    echo "Updating Copix in $INSTALL_DIR …"
    git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH"
    git -C "$INSTALL_DIR" checkout -B "$BRANCH" "origin/$BRANCH"
    git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"
    # -ffd also removes nested git repos left behind by old agent sessions
    git -C "$INSTALL_DIR" clean -ffd
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

chmod +x "$INSTALL_DIR/cli/bin/copix.js"

echo "Installing CLI dependencies …"
npm install --prefix "$INSTALL_DIR/cli" --omit=dev --silent

# --- Permanent binary placement -------------------------------------------------

path_has_dir() {
  case ":$PATH:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

is_writable_dir() {
  [ -d "$1" ] && [ -w "$1" ]
}

ensure_dir() {
  mkdir -p "$1" 2>/dev/null || return 1
  [ -w "$1" ]
}

# Append PATH export to a profile once (idempotent).
persist_path_in_file() {
  local file="$1"
  local bin_dir="$2"
  local line="export PATH=\"${bin_dir}:\$PATH\""
  touch "$file"
  if grep -Fqs "$PATH_MARKER" "$file" 2>/dev/null; then
    return 0
  fi
  {
    echo ""
    echo "$PATH_MARKER"
    echo "$line"
  } >> "$file"
}

persist_path_for_shells() {
  local bin_dir="$1"
  local updated=()
  # macOS login + interactive shells; Linux bash/zsh
  local candidates=(
    "$HOME/.zprofile"
    "$HOME/.zshrc"
    "$HOME/.bash_profile"
    "$HOME/.bashrc"
    "$HOME/.profile"
  )
  local f
  for f in "${candidates[@]}"; do
    # Only touch files that already exist, plus always ensure zshrc/zprofile on macOS/zsh
    if [ -f "$f" ] || [[ "$f" == "$HOME/.zprofile" || "$f" == "$HOME/.zshrc" ]]; then
      persist_path_in_file "$f" "$bin_dir"
      updated+=("$f")
    fi
  done
  if [ "${#updated[@]}" -gt 0 ]; then
    echo "Permanently added ${bin_dir} to PATH in: ${updated[*]}"
  fi
}

link_copix() {
  local bin_dir="$1"
  ensure_dir "$bin_dir" || return 1
  ln -sfn "$INSTALL_DIR/cli/bin/copix.js" "$bin_dir/copix"
  chmod +x "$bin_dir/copix"
  echo "$bin_dir/copix"
}

COPIX_BIN=""
INSTALL_METHOD=""

# 1) Prefer npm global (usually already on PATH for Homebrew / official Node / nvm)
if [ -z "${COPIX_BIN_DIR:-}" ]; then
  if npm install -g "$INSTALL_DIR/cli" --silent 2>/tmp/copix-npm-g.err; then
    NPM_PREFIX="$(npm prefix -g 2>/dev/null || true)"
    if [ -n "$NPM_PREFIX" ] && [ -x "$NPM_PREFIX/bin/copix" ]; then
      COPIX_BIN="$NPM_PREFIX/bin/copix"
      INSTALL_METHOD="npm-global"
    elif command -v copix >/dev/null 2>&1; then
      COPIX_BIN="$(command -v copix)"
      INSTALL_METHOD="npm-global"
    fi
  fi
fi

# 2) Explicit override or a directory already on PATH
if [ -z "$COPIX_BIN" ]; then
  CANDIDATES=()
  if [ -n "${COPIX_BIN_DIR:-}" ]; then
    CANDIDATES+=("$COPIX_BIN_DIR")
  fi
  # Homebrew / standard locations first
  CANDIDATES+=("/opt/homebrew/bin" "/usr/local/bin" "$HOME/.local/bin")
  # Any other writable bin-like dir already on PATH
  OLD_IFS="$IFS"
  IFS=':'
  for d in $PATH; do
    [ -n "$d" ] || continue
    case "$d" in
      */bin|*/bin/*) CANDIDATES+=("$d") ;;
    esac
  done
  IFS="$OLD_IFS"

  for d in "${CANDIDATES[@]}"; do
    if path_has_dir "$d" && (is_writable_dir "$d" || ensure_dir "$d"); then
      if COPIX_BIN="$(link_copix "$d")"; then
        INSTALL_METHOD="path-dir"
        break
      fi
    fi
  done
fi

# 3) Last resort: ~/.local/bin + permanently write shell profiles
if [ -z "$COPIX_BIN" ]; then
  FALLBACK="$HOME/.local/bin"
  COPIX_BIN="$(link_copix "$FALLBACK")"
  INSTALL_METHOD="fallback"
  if ! path_has_dir "$FALLBACK"; then
    persist_path_for_shells "$FALLBACK"
    export PATH="$FALLBACK:$PATH"
  fi
fi

# If we linked into a dir not on PATH (rare), persist it
BIN_DIR="$(dirname "$COPIX_BIN")"
if ! path_has_dir "$BIN_DIR"; then
  persist_path_for_shells "$BIN_DIR"
  export PATH="$BIN_DIR:$PATH"
fi

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
echo "Installed permanently: $COPIX_BIN"
case "$INSTALL_METHOD" in
  npm-global) echo "Method: npm global (already on your PATH)" ;;
  path-dir)   echo "Method: linked into $BIN_DIR (already on your PATH)" ;;
  fallback)   echo "Method: $BIN_DIR + shell profile PATH (saved for new terminals)" ;;
esac

# Sanity check in this shell
if command -v copix >/dev/null 2>&1; then
  echo "Verified: $(command -v copix)  ($(copix --version 2>/dev/null || echo 'ok'))"
else
  echo "Note: open a new terminal tab so PATH reloads, then run: copix"
fi

echo
echo "No account required. Copix CLI talks to local Ollama."
echo
echo "Next:"
echo "  ollama pull qwen2.5:3b"
echo "  copix doctor"
echo "  copix"
echo
echo "Windows install:"
echo "  irm https://raw.githubusercontent.com/EJH-BAE/Copix/main/cli/install.ps1 | iex"
