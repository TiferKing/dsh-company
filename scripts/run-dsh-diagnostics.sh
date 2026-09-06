#!/usr/bin/env bash
set -euo pipefail

# Pass Node flags directly to DSH. NODE_OPTIONS is deliberately left unchanged,
# so these diagnostic options are not added to every Node-based employee tool.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
node_bin="$(command -v node)"
dsh_bin="$(command -v dsh)"
dsh_entry="$("$node_bin" -p 'require("node:fs").realpathSync(process.argv[1])' "$dsh_bin")"
case "$dsh_entry" in
  */@deepseek-ai/dsh/lib/bin.js) ;;
  *) printf 'Unexpected DSH executable: %s\n' "$dsh_entry" >&2; exit 1 ;;
esac

umask 077
diagnostic_dir="$HOME/dsh-diagnostics/$(date +%Y%m%d-%H%M%S)-$$"
node_flags=(
  --max-old-space-size=8192
  --heapsnapshot-near-heap-limit=1
  --heapsnapshot-signal=SIGUSR2
  --report-on-fatalerror
  --report-exclude-env
  "--diagnostic-dir=$diagnostic_dir"
  "--report-directory=$diagnostic_dir"
  --require "$script_dir/dsh-memory-probe.cjs"
)

if [[ "${1:-}" == --check ]]; then
  "$node_bin" "${node_flags[@]}" -e 'console.log(JSON.stringify({node:process.version,heapLimitMiB:require("node:v8").getHeapStatistics().heap_size_limit/1048576,dshEntry:process.argv[1]}))' "$dsh_entry"
  exit 0
fi

mkdir -p -- "$diagnostic_dir"
printf 'DSH diagnostics: %s\n' "$diagnostic_dir"
printf 'Memory samples every 15 seconds; Ctrl+C stops DSH.\n'
exec "$node_bin" "${node_flags[@]}" "$dsh_entry" web --no-open "$@" \
  > >(tee -a "$diagnostic_dir/console.log") 2>&1
