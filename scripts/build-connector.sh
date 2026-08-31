#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
plugin="indak-gateway-connector"
version="$(php -r '$s=file_get_contents($argv[1]); preg_match("/^ \\* Version: (.+)$/m", $s, $m); echo $m[1];' "$repo/wordpress/$plugin/$plugin.php")"

mkdir -p "$repo/dist"
archive="$repo/dist/$plugin-$version.zip"

# zip replaces matching entries in an existing archive. Remove only this exact versioned
# artifact first so deleted source files cannot linger in a rebuilt release.
if [ -f "$archive" ]; then
  rm -f "$archive"
fi

(cd "$repo/wordpress" && zip -q -r "$archive" "$plugin" -x '*.DS_Store')
printf 'Built %s\n' "$archive"
unzip -t "$archive"
