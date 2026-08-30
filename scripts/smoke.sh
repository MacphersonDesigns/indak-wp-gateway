#!/usr/bin/env bash
# Verify a DEPLOYED gateway. Both sites must answer in the same run: that is the
# whole point of this thing.
#
#   GATEWAY=https://your-app.up.railway.app TOKEN=... ./scripts/smoke.sh
#   GATEWAY=... TOKEN=... SITE_A=indak SITE_B=strengthennd ./scripts/smoke.sh
set -uo pipefail

: "${GATEWAY:?set GATEWAY to the gateway base URL, e.g. https://app.up.railway.app}"
: "${TOKEN:?set TOKEN to GATEWAY_TOKEN}"
SITE_A="${SITE_A:-indak}"
SITE_B="${SITE_B:-strengthennd}"
MCP="${GATEWAY%/}/mcp"
pass=0; fail=0
ok(){ printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }

rpc(){ curl -sS -m 180 -X POST "$MCP" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d "$1"; }

echo "== health"
h=$(curl -sS -m 20 "${GATEWAY%/}/healthz")
echo "$h" | grep -q '"ok":true' && ok "healthz: $h" || no "healthz returned: $h"

echo "== auth"
code=$(curl -sS -o /dev/null -w '%{http_code}' -m 20 -X POST "$MCP" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
[ "$code" = "401" ] && ok "unauthenticated request rejected (401)" || no "no token got HTTP $code, expected 401"

echo "== tools/list"
tl=$(rpc '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')
n=$(printf '%s' "$tl" | grep -o '"name":"wp_[a-z_]*"' | sort -u | wc -l | tr -d ' ')
[ "$n" = "4" ] && ok "exactly 4 tools exposed" || no "expected 4 tools, saw $n -> $tl"

echo "== wp_list_sites"
ls_out=$(rpc '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"wp_list_sites","arguments":{}}}')
for s in "$SITE_A" "$SITE_B"; do
  printf '%s' "$ls_out" | grep -q "$s" && ok "registry lists $s" || no "$s missing from wp_list_sites"
done

echo "== both sites answer in the same run (the actual bug this fixes)"
a=$(rpc "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"wp_discover_abilities\",\"arguments\":{\"site\":\"$SITE_A\"}}}")
b=$(rpc "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"wp_discover_abilities\",\"arguments\":{\"site\":\"$SITE_B\"}}}")
printf '%s' "$a" | grep -q 'abilities' && ok "$SITE_A returned abilities" || no "$SITE_A: $(printf '%s' "$a" | head -c 400)"
printf '%s' "$b" | grep -q 'abilities' && ok "$SITE_B returned abilities" || no "$SITE_B: $(printf '%s' "$b" | head -c 400)"
if [ "$a" != "$b" ]; then ok "the two sites returned DIFFERENT payloads"
else no "both sites returned identical payloads: routing is broken, stop and fix the gateway"; fi

echo "== guardrails"
w=$(rpc "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"wp_execute_ability\",\"arguments\":{\"site\":\"$SITE_A\",\"ability_name\":\"novamira/execute-php\",\"parameters\":{\"code\":\"return 1+1;\"}}}}")
printf '%s' "$w" | grep -qi 'refus\|disabled\|LIVE' && ok "execute-php refused on $SITE_A" || no "execute-php was NOT refused: $(printf '%s' "$w" | head -c 400)"

t=$(rpc '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"wp_discover_abilities","arguments":{"site":"strengthend"}}}')
printf '%s' "$t" | grep -qi 'unknown site' && ok "typo'd site key refused, not silently routed" || no "typo was not caught: $(printf '%s' "$t" | head -c 300)"

if [ -n "${TOKEN_READONLY:-}" ]; then
  r=$(curl -sS -m 60 -X POST "$MCP" -H "Authorization: Bearer $TOKEN_READONLY" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\"params\":{\"name\":\"wp_execute_ability\",\"arguments\":{\"site\":\"$SITE_B\",\"ability_name\":\"novamira/execute-php\",\"parameters\":{}}}}")
  printf '%s' "$r" | grep -qi 'read-only' && ok "read-only token blocked from writing" || no "read-only token was not blocked: $(printf '%s' "$r" | head -c 300)"
fi

echo
echo "$pass passed, $fail failed"
[ "$fail" = "0" ] || exit 1
