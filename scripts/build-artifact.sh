#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist
mkdir -p dist
bun build src/cli.ts --compile --outfile dist/lastsecrets
chmod 755 dist/lastsecrets
