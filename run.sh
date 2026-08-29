#!/usr/bin/env bash
#
# One-click launcher for macOS / Linux.
#
# The service has zero runtime dependencies (Node built-ins only), so there is
# nothing to install - it just starts. Stop the app with Ctrl+C.
#
#   ./run.sh
#
set -euo pipefail
cd "$(dirname "$0")"

NODE="${NODE:-node}"

if ! command -v "$NODE" >/dev/null 2>&1; then
  echo "Node.js not found. Install Node.js LTS (18+) from https://nodejs.org/ and retry." >&2
  exit 1
fi

echo "Starting Star Citizen Live — dashboard opens at http://localhost:3041/ (Ctrl+C to stop)."
echo "It auto-detects your Star Citizen install and tails the freshest Game.log (read-only)."
# Enable the optional cargo route-optimizer (Cargo tab: routing, inline cargo entry, UEX vocab).
export SC_CARGO_ROUTER="${SC_CARGO_ROUTER:-1}"
exec "$NODE" app/server.js
