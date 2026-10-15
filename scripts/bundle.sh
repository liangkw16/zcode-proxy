#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Build every workspace package to dist/ first; the bundler entry imports
# the compiled output and the workspace packages' package.json `exports`.
mise exec -- pnpm -r build

# esbuild preserves the entry file's own shebang at the top of the bundle;
# do NOT also pass --banner (that yields two shebang lines and a SyntaxError).
mise exec -- pnpm exec esbuild packages/cli/bin/zcode-proxy.js \
  --bundle --platform=node --format=esm --target=node24 \
  --outfile=dist/zcode-proxy.mjs

chmod +x dist/zcode-proxy.mjs
echo "bundled: dist/zcode-proxy.mjs"
