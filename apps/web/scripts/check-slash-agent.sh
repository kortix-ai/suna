#!/usr/bin/env bash
# Run against an authenticated local project composer with at least two agents.
# Usage: AGENT_BROWSER_SESSION=<session> bash scripts/check-slash-agent.sh
set -euo pipefail
before=$(agent-browser eval 'document.querySelector("[aria-label=\"Select agent\"]").textContent')
agent-browser find label 'Message input' fill /
agent-browser press ArrowDown
agent-browser press Enter
agent-browser eval 'Boolean(document.querySelector("[cmdk-list]"))' | grep -qx true
agent-browser press Escape
after=$(agent-browser eval 'document.querySelector("[aria-label=\"Select agent\"]").textContent')
[[ "$before" == "$after" ]]
printf 'slash-agent browser regression: 1 pass, 0 fail\n'
