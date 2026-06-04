/**
 * Tracked todos for spec IDs that have NO black-box HTTP surface to assert.
 * Each registers its spec ID (so the coverage gate counts it as addressed, not
 * silently missing) and renders as a yellow "todo" with the reason it can't be
 * a live HTTP flow. These are deliberate, reviewed exclusions — not laziness.
 */
import { flow } from "../core/flow";

// GH-4 — Supabase GitHub OAuth popup is pure client-side (`signInWithOAuth`);
// the `provider_token` is posted back to the opener window. There is NO Kortix
// API route involved, so nothing to drive over HTTP.
flow("GH-4", { domain: "github", todo: "client-side Supabase OAuth popup — no Kortix API route to exercise" }, async () => {});

// SBX-1 — sandbox create/start is implicit on session create
// (provisionSessionSandbox); there is no standalone endpoint. Covered
// transitively by the session-create flows (RUN-*/SESS-*/GOLD-1).
flow("SBX-1", { domain: "sandboxes", todo: "no standalone endpoint — sandbox create is implicit on session create (see RUN-1/GOLD-1)" }, async () => {});

// SBX-2 — sandbox stop = session DELETE; restart = SESS-9; status read = SESS-8.
// All cross-referenced flows exist; there is no separate sandbox route here.
flow("SBX-2", { domain: "sandboxes", todo: "no standalone endpoint — stop=session DELETE, restart=SESS-9, status=SESS-8 (all covered)" }, async () => {});

// TRG-6 — cron scheduler is a global setInterval sweep (server background
// behavior, gated by KORTIX_TRIGGER_SCHEDULER_ENABLED). Not an HTTP route;
// proven by the live triggers harness (apps/api/scripts/e2e-triggers-live.sh),
// not black-box-assertable here without driving wall-clock + a funded session.
flow("TRG-6", { domain: "triggers", todo: "internal cron scheduler (setInterval sweep) — no HTTP surface; covered by e2e-triggers-live" }, async () => {});

// TRG-8 — fire→run actor selection + backpressure is internal to fireGitTrigger
// /createProjectSession; spawning a real session needs the funded capability.
// The fire entrypoints' boundaries are covered by the webhook fire flows.
flow("TRG-8", { domain: "triggers", todo: "internal fire→run (actor=first owner, backpressure) — needs funded session; entrypoint boundaries covered elsewhere" }, async () => {});

// TRG-9 — there is NO inbound GitHub-event webhook; a GitHub repo webhook is
// modelled as a generic `webhook` trigger. The generic webhook fire route's
// auth/validation boundary is already covered (webhooks/projects fire); the
// real fire spawns a funded session.
flow("TRG-9", { domain: "triggers", todo: "no GitHub-event webhook — generic webhook fire boundary covered; real fire needs funded session" }, async () => {});
