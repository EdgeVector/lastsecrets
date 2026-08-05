#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist
mkdir -p dist bin
bun build src/cli.ts --compile --outfile "dist/lastsecrets"
chmod 755 "dist/lastsecrets"
# Host-track requires non-empty bin/; ship a thin launcher that execs dist.
cat > "bin/lastsecrets" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)"
exec "$root/dist/lastsecrets" "$@"
SH
chmod 755 "bin/lastsecrets"
