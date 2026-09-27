---
recorded: 2026-09-06T03:06:42Z
incident_date: 2026-09-06
commit: 3caec60726
---
# One attachment tile, translated to tokens — never a mockup's pixels

**When:** a reference screenshot arrives for a surface that two places render
(the composer's attachment preview and the sent message). Build ONE component
(`features/session/attachment-tile.tsx` → `AttachmentTile`) and make both
surfaces consume it; two hand-kept copies drifted into an 80px image square
beside a 120px file rectangle, and every message got a ragged right edge.
Translate, don't trace: the reference's ~108px tile became `size-24` (the
0.23rem scale), its ~12px corner became `rounded-md`, its lifted fill became
`bg-popover`, its uppercase `MD` badge became the design system's `Badge`
`size="xs"` lowercased (all-caps eyebrows are a rejected default), and its
"faint text peek" — the one value that had no token (`text-[7px]`) — was
dropped rather than kept. A long name is an ellipsized head plus its verbatim
ten-character tail on line two, because the tail carries the extension.
Verify in BOTH themes with the real bundle pointed at the branch API — a
`NEXT_PUBLIC_*` value is inlined at compile, and `dev-local.sh` used to
hardcode the primary api port into it. *Enforcer:* `attachment-tile.test.tsx`,
`composer/attachment-tiles.test.tsx` ("image and file tiles are ONE square"),
`optimistic-turn.test.tsx` (shell and chat ship the same surface), and
`audit.sh` clean on the tile.
