#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p "$HOME/.local/bin"
cp dist/zcode-proxy.mjs "$HOME/.local/bin/zcode-proxy"
chmod +x "$HOME/.local/bin/zcode-proxy"
echo "installed: $HOME/.local/bin/zcode-proxy"
