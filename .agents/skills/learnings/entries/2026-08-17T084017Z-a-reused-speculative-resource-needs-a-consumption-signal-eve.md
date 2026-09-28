---
recorded: 2026-08-17T08:40:17Z
incident_date: 2026-08-17
commit: 44125f135a
---
# A reused speculative resource needs a consumption signal every holder can see

**When:** caching a server-side find-or-create resource client-side (the warm
session ready-store; any pre-provisioned handle). `POST /sessions/warm` reuses
ONE still-unused session per user+project, so every tab, browser and device of
that user holds the SAME id — and a per-tab in-memory store then trusts its
held copy for its whole dwell. The moment ANY holder uses the resource, every
other copy silently points at a session with a conversation in it; the next
project-home send navigates there and auto-sends into it. Holding is not
owning: consult a synchronous cross-holder registry at take time (localStorage
is the only sync cross-tab channel), record every take AND every navigation
into a session, and revalidate a held copy on visibility regain (scopes
localStorage cannot cross). Corollary that let it ship: every session e2e flow
`requires: ['daytona']`, so NO warm contract runs in local CI — green local
gates proved nothing about this feature.
*Incident:* 2026-08-17, dev, night before a customer release — home prompts
delivered into previous sessions; newest session missing from the list (list
seed wiped by refetches racing the `/start` marker drop; adoption stamped no
activity or `updated_at`).
*Enforcer:* `warm-session-taken-registry.test.ts` +
`use-warm-project-session.test.ts` (cross-tab takes, navigation consumption,
revalidation); SESS-18 pins `/start` adoption, list order and
`exclude_session_id` — but only at staging gates (daytona-gated locally:
still a gap).
