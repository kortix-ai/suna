---
recorded: 2026-09-06T03:06:42Z
incident_date: 2026-09-06
commit: 3caec60726
---
# A placeholder's release is a LATCH, and the real thing must draw through the swap

**When:** an optimistic stand-in hands over to the transcript's own copy of a
message. The transcript's first message briefly has NO parts while the store
swaps the optimistic copy for the runtime's echo (~176 ms as the file parts
land, on video). A live boolean ("show the stand-in unless the transcript has
text") flipped back: the stand-in re-mounted at full opacity over the dimmed
real turn, then dropped again — "the same message twice for a millisecond,
then it vanishes". **The rule:** once a placeholder steps aside it never
returns (latch the release), and the real turn is handed everything the
placeholder knew — text and file names — so it keeps drawing through frames
where its own parts are still streaming. Measure handovers with a per-mutation
DOM observer plus a video recording, and count only VISIBLE copies (walk
ancestors for opacity/display): DOM counts alone flagged the aligned 300 ms
crossfade as a duplicate the eye never sees. *Enforcer:*
`first-prompt-handover.test.ts` ("a release is a latch"), `user-message.test.tsx`
("keeps the bubble and the promised tiles through a frame with no parts").
