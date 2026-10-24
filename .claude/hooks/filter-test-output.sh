#!/bin/bash
# PreToolUse(Bash): rewrite plain test-runner commands so only failures reach the context.
# Success prints one line; failure prints matching failure lines (or the tail) plus the exit code.
input=$(cat)
cmd=$(echo "$input" | jq -r '.tool_input.command // empty')

pattern='^(npm test|npm run test|npx vitest run|vitest run|node --test|pytest|python3? -m pytest|go test|cargo test|composer test|phpunit|vendor/bin/phpunit)( [^;&|<>`$#\\[:cntrl:]]*)?$'
if [[ "$cmd" =~ $pattern ]]; then
  filtered="out=\$($cmd 2>&1); rc=\$?; if [ \$rc -eq 0 ]; then echo \"OK (exit 0; output hidden by filter-test-output hook)\"; else printf '%s\n' \"\$out\" | grep -A5 -E '(FAIL|ERROR|error:|AssertionError|not ok|FAILURES|Failures:|✗|×|✖)' | head -100 | grep . || printf '%s\n' \"\$out\" | tail -30; echo \"exit code: \$rc (filtered by hook; rerun without the hook for full output)\"; fi; exit \$rc"
  echo "$input" | jq --arg filtered "$filtered" \
    '{hookSpecificOutput: {hookEventName: "PreToolUse", updatedInput: (.tool_input + {command: $filtered})}}'
else
  echo "{}"
fi
