#!/usr/bin/env bash
# Start an extracted release package and check that it serves the API and the web UI.
#
#   scripts/smoke-test.sh <folder containing rexarr/ or rexarr.app/> <expected version> [port]
set -euo pipefail
root="$1"
version="$2"
port="${3:-3939}"
config="$(mktemp -d)"
# Windows (Git Bash): hand node.exe a native path
native_config="$config"
command -v cygpath > /dev/null && native_config="$(cygpath -w "$config")"
export REXARR_CONFIG_DIR="$native_config" REXARR_PORT="$port" REXARR_NO_BROWSER=1

if [ -d "$root/rexarr.app" ]; then
  cmd=("$root/rexarr.app/Contents/MacOS/rexarr")
elif [ -f "$root/rexarr/runtime/node.exe" ]; then
  cmd=("$root/rexarr/runtime/node.exe" "$root/rexarr/server/dist/server/src/index.js")
else
  cmd=("$root/rexarr/rexarr")
fi
echo "starting: ${cmd[*]}"
"${cmd[@]}" > "$config/stdout.log" 2>&1 &
pid=$!
cleanup() {
  curl -fsS -X POST "http://127.0.0.1:$port/api/system/shutdown" > /dev/null 2>&1 || kill "$pid" 2> /dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$port/api/health" > "$config/health.json" 2> /dev/null; then break; fi
  if ! kill -0 "$pid" 2> /dev/null; then
    echo "rexarr exited early:"
    cat "$config/stdout.log"
    exit 1
  fi
  sleep 1
done
cat "$config/health.json"
echo
grep -q "\"version\":\"$version\"" "$config/health.json" || { echo "expected version $version"; cat "$config/stdout.log"; exit 1; }
curl -fsS "http://127.0.0.1:$port/" | grep -qi "<div id=\"root\"" || { echo "web UI not served"; exit 1; }
curl -fsS "http://127.0.0.1:$port/api/system" | grep -q '"package":{' || { echo "package_info not detected"; exit 1; }
curl -fsS -X POST "http://127.0.0.1:$port/api/system/shutdown" > /dev/null
for _ in $(seq 1 15); do
  kill -0 "$pid" 2> /dev/null || { trap - EXIT; echo "ok: rexarr $version served the API and UI and shut down"; exit 0; }
  sleep 1
done
echo "rexarr did not shut down"
exit 1
