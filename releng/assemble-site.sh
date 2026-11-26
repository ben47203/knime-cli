#!/usr/bin/env bash
# Lay out the GitHub Pages site: the landing page at / and the built p2
# repository at /update/. Run after `mvn -B clean verify`.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$root/target/site}"
repo="$root/releng/com.ben47203.knimecli.update/target/repository"

[ -f "$repo/content.jar" ] || { echo "no p2 repository at $repo; run mvn -B clean verify first" >&2; exit 1; }

rm -rf "$out"
mkdir -p "$out/update"
cp "$root/site/index.html" "$out/"
cp -R "$repo/." "$out/update/"
echo "site assembled in $out"
