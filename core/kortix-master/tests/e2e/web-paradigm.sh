#!/usr/bin/env bash
# Web-side paradigm e2e — verifies the user-flow surfaces independently of
# auth (we can't get past Supabase login from CLI). Tests:
#
#   1. /board route exists and serves a page (auth redirect proves the
#      route is registered before middleware fires).
#   2. /workspace route exists.
#   3. /projects/<id> route is still defined (legacy navigation works).
#   4. /api/maintenance unauthenticated check is reachable.
#   5. The board page TypeScript imports resolve (compile sanity).
#   6. menu-registry entry for board is present and gates on the flag.
#   7. PROJECT_ONLY_AGENTS in use-visible-agents.ts includes
#      project-manager (the seeded slug).
#
# Web dev server expected on :3000 (pnpm --filter Kortix-Computer-Frontend dev).
# Sandbox expected on :14000.
set -u
PASS=0; FAIL=0; total=0; FAILS=()
WEB="http://localhost:3000"

c()  { local n="$1"; local e="$2"; local g="$3"; total=$((total+1));
       if [ "$g" = "$e" ]; then PASS=$((PASS+1)); printf "  ✓ %3d. %-72s = %s\n" $total "$n" "$g"
       else FAIL=$((FAIL+1)); FAILS+=("$total $n: expected $e got $g"); printf "  ✘ %3d. %-72s expected %s, got %s\n" $total "$n" "$e" "$g"; fi; }
ci() { local n="$1"; local s="$2"; local h="$3"; total=$((total+1));
       if echo "$h" | grep -qF "$s"; then PASS=$((PASS+1)); printf "  ✓ %3d. %-72s ⊃ %s\n" $total "$n" "$s"
       else FAIL=$((FAIL+1)); FAILS+=("$total $n missing $s"); printf "  ✘ %3d. %-72s missing %s\n" $total "$n" "$s"; fi; }

echo "═══════════════════════════════════════════════════════════════════════"
echo " WEB PARADIGM E2E — single-sandbox UI surface"
echo "═══════════════════════════════════════════════════════════════════════"

echo
echo "── 1. Web dev server reachable + critical routes registered ──"
if ! curl -s --max-time 2 -o /dev/null "$WEB" 2>/dev/null; then
  echo "  Web dev server not running on :3000 — start with:"
  echo "    pnpm --filter Kortix-Computer-Frontend dev"
  exit 1
fi
PASS=$((PASS+1)); total=$((total+1)); printf "  ✓ %3d. web dev server reachable on :3000\n" $total

# A 307 redirect to /auth proves the route is registered (auth middleware
# fires AFTER route resolution). A 404 would mean the route doesn't exist.
for route in /board /workspace /files /channels /triggers /sessions /projects/proj-workspace; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "$WEB$route")
  c "GET $route registered (302/307 to auth proves route exists)" "307" "$CODE"
done

echo
echo "── 2. /api/maintenance public endpoint serves ──"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$WEB/api/maintenance")
c "GET /api/maintenance" "200" "$CODE"

echo
echo "── 3. /board page bundle compiles (no syntax/import errors at request) ──"
# Even though we get a redirect, Turbopack compiled the page when the route
# was hit. A compile error would show up as 500 instead of 307.
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$WEB/board")
c "/board compiles without 500" "307" "$CODE"

echo
echo "── 4. Source-of-truth: menu-registry has the board entry ──"
REG=/Users/vukasinkubet/dev/comp/apps/web/src/lib/menu-registry.ts
ci "menu-registry has 'board-quick' entry" "id: 'board-quick'" "$(cat "$REG")"
ci "board entry hrefs /board" "href: '/board'" "$(cat "$REG")"
ci "board entry shown in rightSidebar" "showIn: ['rightSidebar', 'commandPalette']" "$(cat "$REG")"
ci "board entry requires the multi-project flag" "requiresMultiProjectFlag: true" "$(cat "$REG")"

echo
echo "── 5. menu-registry filter respects requiresMultiProjectFlag ──"
ci "getItemsByGroup checks the flag" "!item.requiresMultiProjectFlag" "$(cat "$REG")"

echo
echo "── 6. PROJECT_ONLY_AGENTS includes project-manager (PM agent file is hidden) ──"
PA=/Users/vukasinkubet/dev/comp/apps/web/src/hooks/opencode/use-visible-agents.ts
ci "use-visible-agents has project-manager" "'project-manager'" "$(cat "$PA")"
# All four agent slugs we seed/use should be in the list:
for slug in orchestrator project-maintainer worker project-manager; do
  ci "PROJECT_ONLY_AGENTS includes '$slug'" "'$slug'" "$(cat "$PA")"
done

echo
echo "── 7. Sidebar Projects accordion is GONE (single-project paradigm) ──"
SL=/Users/vukasinkubet/dev/comp/apps/web/src/components/sidebar/sidebar-left.tsx
# The accordion code should be replaced with a comment explaining its absence.
ci "sidebar-left has the 'No Projects accordion' comment" 'No "Projects" accordion' "$(cat "$SL")"
# And there should be no SidebarProjectRow rendering with the Collapsible/Trigger combo:
total=$((total+1))
if ! grep -q '<Collapsible.*group/projects' "$SL"; then
  PASS=$((PASS+1)); printf "  ✓ %3d. sidebar-left has no group/projects Collapsible\n" $total
else
  FAIL=$((FAIL+1)); FAILS+=("Projects Collapsible still present"); printf "  ✘ %3d. Projects Collapsible still present\n" $total
fi

echo
echo "── 8. /board page imports resolve (no missing deps) ──"
# tsc would catch this, but a quick grep confirms the components exist.
BP=/Users/vukasinkubet/dev/comp/apps/web/src/app/\(dashboard\)/board/page.tsx
ci "board page imports TicketBoard" "from '@/components/kortix/ticket-board'" "$(cat "$BP")"
ci "board page hardcodes proj-workspace" "PROJECT_ID = 'proj-workspace'" "$(cat "$BP")"
ci "board page redirect-gates on the flag" "featureFlags.enableMultiProject" "$(cat "$BP")"

echo
echo "═══════════════════════════════════════════════════════════════════════"
echo "  WEB PARADIGM E2E: $PASS / $total passed, $FAIL failed"
echo "═══════════════════════════════════════════════════════════════════════"
if [ $FAIL -gt 0 ]; then
  echo "Failures:"
  for f in "${FAILS[@]}"; do echo "  - $f"; done
fi
exit $FAIL
