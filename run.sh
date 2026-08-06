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

# Serve with caching disabled. python's default handler sends no Cache-Control,
# so browsers heuristically cache src/*.js and can pair a fresh index.html with
# stale modules. Bind 0.0.0.0 so other devices on the LAN can reach it.
exec python3 -c '
import sys
from http.server import SimpleHTTPRequestHandler, test

class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

test(HandlerClass=Handler, port=int(sys.argv[1]), bind="0.0.0.0")
' "$PORT"
