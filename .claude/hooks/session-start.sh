#!/bin/bash
# Cloud sessions: install the Node.js release CI uses, the npm dependencies,
# and the Git LFS installers the research-archives test hashes.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

NODE_VERSION=26.5.0
# SHA-256 of node-v26.5.0-linux-x64.tar.xz from nodejs.org/dist/v26.5.0/SHASUMS256.txt.
NODE_SHA256=9f619528f1db5ddc41dccf54211066fb42228d69a156733c69cb9d6cc92e358c
NODE_HOME="$HOME/.cache/node-v$NODE_VERSION-linux-x64"

if [ "$(uname -m)" = "x86_64" ] && [ ! -x "$NODE_HOME/bin/node" ]; then
  archive="$(mktemp -d)/node.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" -o "$archive"
  echo "$NODE_SHA256  $archive" | sha256sum --check --quiet
  mkdir -p "$HOME/.cache"
  tar -xJf "$archive" -C "$HOME/.cache"
  rm -rf "$(dirname "$archive")"
fi

if [ -x "$NODE_HOME/bin/node" ]; then
  export PATH="$NODE_HOME/bin:$PATH"
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "export PATH=\"$NODE_HOME/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
  fi
fi

cd "$CLAUDE_PROJECT_DIR"
npm install --no-audit --no-fund

git lfs install --local >/dev/null
git lfs pull
