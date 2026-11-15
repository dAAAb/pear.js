#!/usr/bin/env bash
# Checks the built page in a real headless Chromium: web/tests/browser_check.py serves dist-web/ and a stand-in
# model service on 127.0.0.1 and drives the browser. This script does not build the page: run `npm run build:web`
# first. (The check's part "selftest" builds its own page, web/selftest.html, into dist-web/.)
#
#   bash web/tests/run_check.sh [arguments of browser_check.py: --out DIR, --build STAMP, --only PART ..., --list]
#
# From the environment:
#   PW_PYTHON                  a Python with Playwright and its Chromium (default: python3)
#   NODE                       a Node for which this repository's node_modules were installed (default: node);
#                              under WSL with a Windows checkout that is node.exe
#   PLAYWRIGHT_BROWSERS_PATH   where Playwright keeps its browsers, if not in its default place
#
# Not part of `npm test`. It never uses the GPU and listens on 127.0.0.1 only.
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PW_PYTHON=${PW_PYTHON:-python3}
NODE=${NODE:-node}

if [ ! -f "$ROOT/dist-web/index.html" ]; then
  echo "No built page at dist-web/: run 'npm run build:web' first"
  exit 2
fi

cd "$ROOT" || exit 2
exec "$PW_PYTHON" -u web/tests/browser_check.py --node "$NODE" "$@"
