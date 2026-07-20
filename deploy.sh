#!/usr/bin/env bash
# Deploy to GitHub Pages with cache-busting.
# GitHub Pages serves js/*.js with Cache-Control: max-age=600, and the <script>
# tags aren't cache-busted by default, so a browser that visited in the last 10
# min replays the STALE main.js — you push a fix and it never reaches the player.
# This stamps a fresh ?v=<epoch> into every js/*.js?v=DEPLOY_VER... reference so
# each deploy forces a fresh download, then commits + pushes.
set -euo pipefail
cd "$(dirname "$0")"

VER="$(date +%s)"
# Rewrite any existing ?v=... (or the DEPLOY_VER placeholder) on local js refs to the new version.
sed -i -E "s#(src=\"js/[^\"]*\.js)\?v=[^\"]*#\1?v=${VER}#g" index.html phone.html

MSG="${1:-Deploy $(date -u +%Y-%m-%dT%H:%MZ)}"
git add -A
git commit -q -m "$MSG" || { echo "nothing to commit"; }
git push -q origin main
echo "deployed v=${VER} -> https://xanboo78o.github.io/apex-racer/"
echo "(Pages rebuild takes ~1-2 min)"
