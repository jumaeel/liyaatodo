#!/usr/bin/env bash
# Cloudflare Pages (Git) build step.
# Stages only the static site assets into ./public so config files
# (firebase.json, firestore.rules, .firebaserc, build.sh, …) are never served.
set -euo pipefail

rm -rf public
mkdir -p public
cp index.html app.js styles.css sw.js manifest.json logo-mark.svg firebase-config.js _headers preview-dashboard.jpg public/

echo "✓ Staged $(ls public | wc -l | tr -d ' ') files into public/"
