#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../wordpress/indak-gateway-connector" && pwd)"
count=0
while IFS= read -r file; do
  php -l "$file" >/dev/null
  printf 'PASS PHP syntax: %s\n' "${file#"$root"/}"
  count=$((count + 1))
done < <(find "$root" -type f -name '*.php' | sort)
printf '\n%s PHP files passed syntax checks.\n' "$count"
