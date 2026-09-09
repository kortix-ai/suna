// THE DOCUMENT THE CONTROL PLANE READS ON EVERY SESSION OPEN.
//
// `GET /kortix/opencode/state` is what `fetchRuntimeState` pulls and
// `saveRuntimeProjection` stores; the bundle then serves it back to the browser
// as the session's `runtime` leg. The cell served no such route, so the leg was
// `{known:false, reason:"no_projection"}` on every open — measured on dev
// 2026-09-09, three reads of a live cell session, `state sections: (none)`.
// The transcript still painted (it comes from Postgres); the model picker, the
// agent roster and the permission list had nothing behind them.
//
// TWO RULES DECIDE WHETHER THIS IS ACCEPTED OR SILENTLY DISCARDED, and both are
// in the API's `resolveRuntimeLeg`:
//
//   1. `identity.opencode_session_id` must equal the session's pin, or the leg
//      reads `identity_mismatch` — stored, then refused. For a cell the pin IS
//      the session id: measured on dev, six of six rows with
//      `project_sessions.opencode_session_id = session_id`.
//   2. A projection older than PROJECTION_MAX_AGE_MS (6 h) on a running box
//      reads `stale`, so `built_at` must be the moment it was built.
//
// KNOWN IS NOT A DEFAULT. Every section carries `{known, value}` and the API
// passes it through verbatim, so `known: true` with an empty array is a claim
// that there are none — which is true of a cell's permissions and false of its
// commands. Saying `known: false` with a reason is how a section that the cell
// genuinely cannot answer stays distinguishable from one that is empty.

/** A section the cell can answer. */
const known = (value) => ({ known: true, value });
/** A section it cannot, and why — never an empty array pretending to be an answer. */
const unknown = (reason, value) => ({ known: false, reason, value });

/**
 * The projection, from what the cell actually holds.
 *
 * Pure: everything it needs is passed in, so the shape can be asserted without
 * a cell, a model or a socket.
 */
export function runtimeStateDoc(input) {
  const {
    sessionId, epoch, seq, sessions, busy, model, skills, builtAt,
  } = input;
  return {
    epoch,
    seq,
    built_at: new Date(builtAt).toISOString(),
    identity: {
      // The pin, and the reason this document is not thrown away on read.
      opencode_session_id: sessionId,
      opencode_version: "pi",
      // A cell has no daemon binary and no compiled agent config, and a number
      // invented here would be compared against a real one somewhere else.
      daemon_build: null,
      agent_config_etag: null,
      head_seq: null,
    },
    // ONE AGENT, because a cell runs one. `model.providerID` is what the web
    // client's roster reads; the kortix-worker bundle test pins the same field.
    agents: known([{
      name: "pi-in-a-cell",
      description: "the pi agent, running inside a celld cell",
      model: { providerID: model?.provider ?? null, modelID: model?.id ?? null },
    }]),
    // A cell has skills, not a command palette. They are not the same list and
    // mapping one onto the other would be a guess presented as a fact.
    commands: unknown("a cell has skills, not commands", []),
    config: known({
      model: model?.id ?? null,
      provider: model?.provider ?? null,
      skills: (skills ?? []).map((s) => s?.name).filter(Boolean),
    }),
    sessions: known(sessions ?? []),
    statuses: known({ [sessionId]: { type: busy ? "busy" : "idle" } }),
    // Empty and KNOWN: a cell never asks for permission and never asks a
    // question, so there are none — which is an answer, not a gap.
    permissions: known([]),
    questions: known([]),
  };
}

/**
 * A weak ETag over everything EXCEPT `built_at`.
 *
 * `fetchRuntimeState` sends `If-None-Match` and honours 304, and
 * `saveRuntimeProjection` keys on the etag. Including the timestamp would make
 * every read a new etag, so the API would store a fresh row on every open
 * forever and the 304 path would never once fire.
 */
export function projectionEtag(doc) {
  const { built_at, ...rest } = doc;
  const json = JSON.stringify(rest);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `W/"${h1.toString(16)}${h2.toString(16)}"`;
}
