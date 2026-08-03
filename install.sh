#!/usr/bin/env bash
# Copix CLI installer (macOS / Linux)
# Permanent install into a real bin dir already on PATH.
# Never edits shell profiles (.zshrc / .bashrc / etc.).
#
# curl -fsSL https://raw.githubusercontent.com/EJH-BAE/Copix/refs/heads/main/cli/install.sh | bash
set -euo pipefail

INSTALLER_VERSION="1.7.0"
REPO="${COPIX_REPO:-https://github.com/EJH-BAE/Copix.git}"
BRANCH="${COPIX_BRANCH:-main}"
INSTALL_DIR="${COPIX_INSTALL_DIR:-$HOME/.copix}"

echo "Copix CLI installer ${INSTALLER_VERSION}"
echo "Permanent install — no shell profile edits"
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

# Remove leftover ~/.local/bin shim from older installers (optional cleanup)
if [ -L "$HOME/.local/bin/copix" ] || [ -f "$HOME/.local/bin/copix" ]; then
  rm -f "$HOME/.local/bin/copix" 2>/dev/null || true
fi

# Remove PATH markers older installers may have added (we never want profile hacks)
cleanup_old_profile_marker() {
  local file="$1"
  [ -f "$file" ] || return 0
  if grep -Fqs '# Copix CLI' "$file" 2>/dev/null; then
    local tmp
    tmp="$(mktemp)"
    # Drop the marker line and the following export PATH=… line
    awk '
      $0 == "# Copix CLI" { skip=1; next }
      skip==1 && $0 ~ /^export PATH=/ { skip=0; next }
      { skip=0; print }
    ' "$file" > "$tmp" && mv "$tmp" "$file"
    echo "Removed old Copix PATH lines from $file"
  fi
}
cleanup_old_profile_marker "$HOME/.zshrc"
cleanup_old_profile_marker "$HOME/.zprofile"
cleanup_old_profile_marker "$HOME/.bashrc"
cleanup_old_profile_marker "$HOME/.bash_profile"
cleanup_old_profile_marker "$HOME/.profile"

path_has_dir() {
  case ":$PATH:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

write_wrapper() {
  # $1 = destination path for `copix`
  # $2 = "sudo" or "user"
  local dest="$1"
  local mode="$2"
  local body
  body="$(cat <<EOF
#!/usr/bin/env bash
exec node "$INSTALL_DIR/cli/bin/copix.js" "\$@"
EOF
)"
  if [ "$mode" = "sudo" ]; then
    echo "$body" | sudo tee "$dest" >/dev/null
    sudo chmod 755 "$dest"
  else
    printf '%s\n' "$body" > "$dest"
    chmod 755 "$dest"
  fi
}

try_install_dir() {
  local bin_dir="$1"
  local mode="$2" # user | sudo
  [ -n "$bin_dir" ] || return 1

  if [ "$mode" = "user" ]; then
    mkdir -p "$bin_dir" 2>/dev/null || return 1
    [ -w "$bin_dir" ] || return 1
    write_wrapper "$bin_dir/copix" user || return 1
  else
    sudo mkdir -p "$bin_dir"
    write_wrapper "$bin_dir/copix" sudo || return 1
  fi
  echo "$bin_dir/copix"
}

COPIX_BIN=""
METHOD=""

# 1) Explicit override
if [ -n "${COPIX_BIN_DIR:-}" ]; then
  if COPIX_BIN="$(try_install_dir "$COPIX_BIN_DIR" user)"; then
    METHOD="COPIX_BIN_DIR"
  elif COPIX_BIN="$(try_install_dir "$COPIX_BIN_DIR" sudo)"; then
    METHOD="COPIX_BIN_DIR (sudo)"
  else
    echo "Cannot write to COPIX_BIN_DIR=$COPIX_BIN_DIR"
    exit 1
  fi
fi

# 2) npm global — only accept if the resulting bin dir is already on PATH
if [ -z "$COPIX_BIN" ]; then
  NPM_PREFIX="$(npm prefix -g 2>/dev/null || true)"
  NPM_BIN_DIR=""
  if [ -n "$NPM_PREFIX" ]; then
    if [ -d "$NPM_PREFIX/bin" ]; then
      NPM_BIN_DIR="$NPM_PREFIX/bin"
    else
      NPM_BIN_DIR="$NPM_PREFIX"
    fi
  fi
  if [ -n "$NPM_BIN_DIR" ] && path_has_dir "$NPM_BIN_DIR" && [ -w "$NPM_BIN_DIR" ]; then
    if npm install -g "$INSTALL_DIR/cli" --silent 2>/tmp/copix-npm-g.err; then
      if [ -x "$NPM_BIN_DIR/copix" ]; then
        COPIX_BIN="$NPM_BIN_DIR/copix"
        METHOD="npm-global ($NPM_BIN_DIR)"
      fi
    fi
  fi
fi

# 3) Homebrew bin (Apple Silicon / Intel) when already on PATH and writable
if [ -z "$COPIX_BIN" ]; then
  for d in /opt/homebrew/bin /usr/local/bin; do
    if path_has_dir "$d" && [ -d "$d" ] && [ -w "$d" ]; then
      if COPIX_BIN="$(try_install_dir "$d" user)"; then
        METHOD="$d"
        break
      fi
    fi
  done
fi

# 4) /usr/local/bin with sudo — on default macOS/Linux PATH, no profile edits
if [ -z "$COPIX_BIN" ]; then
  echo
  echo "Installing to /usr/local/bin (on your default PATH)."
  echo "macOS may ask for your password once."
  echo
  if COPIX_BIN="$(try_install_dir /usr/local/bin sudo)"; then
    METHOD="/usr/local/bin (sudo)"
  fi
fi

if [ -z "$COPIX_BIN" ]; then
  echo "Install failed: could not write a \`copix\` command onto your PATH."
  echo "Try: sudo mkdir -p /usr/local/bin && re-run this installer."
  exit 1
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

# Make the new binary visible in this shell (hash table)
hash -r 2>/dev/null || true

echo
echo "Installed: $COPIX_BIN"
echo "Method:    $METHOD"
echo "No shell profiles were modified."

if command -v copix >/dev/null 2>&1; then
  echo "Verified:  $(command -v copix) ($(copix --version 2>/dev/null || true))"
else
  # /usr/local/bin should already be on PATH; force a hint only if somehow missing
  if path_has_dir "$(dirname "$COPIX_BIN")"; then
    echo "If \`copix\` is not found, run: hash -r"
  else
    echo "WARNING: $(dirname "$COPIX_BIN") is not on PATH in this shell."
    echo "It is on the default macOS PATH — open a new Terminal window and run: copix doctor"
  fi
fi

echo
echo "Next:"
echo "  ollama pull qwen2.5:3b"
echo "  copix doctor"
echo "  copix"
