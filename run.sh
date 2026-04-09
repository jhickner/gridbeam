#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
PORT="${PORT:-8000}"
URL="http://localhost:$PORT"
echo "Serving Grid Beam Editor at $URL"

# Open the URL once the server is listening (background; won't block the server).
(
  for _ in 1 2 3 4 5 10 20; do
    if curl -sf -o /dev/null "$URL"; then break; fi
    sleep 0.2
  done
  if command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
  fi
) &

exec python3 -m http.server "$PORT"
