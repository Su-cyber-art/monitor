#!/bin/sh
# Real Linux processes, two different agent builds, no production signing key.
# scripts/e2e-upgrade.sh /absolute/old/monitor-agent /absolute/new/monitor-agent
set -eu
[ "$#" -eq 2 ] || { echo "usage: $0 OLD_AGENT NEW_AGENT" >&2; exit 2; }
[ "$(uname -s)" = Linux ] || { echo "agent upgrade e2e runs on Linux" >&2; exit 2; }
OLD_AGENT=$(realpath "$1")
NEW_AGENT=$(realpath "$2")
cd "$(dirname "$0")/.."
MONITOR_E2E_AGENT_OLD="$OLD_AGENT" MONITOR_E2E_AGENT_NEW="$NEW_AGENT" \
  cargo test --locked upgrade_e2e::batch_self_update -- --ignored --nocapture
