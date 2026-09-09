// THE PROJECTION THE CONTROL PLANE STORES.
//
// Two rules in the API's `resolveRuntimeLeg` decide whether this document is
// served to the browser or stored and then refused, and neither of them
// produces an error anywhere a person would look: a wrong
// `identity.opencode_session_id` reads back as `identity_mismatch`, and a
// missing `built_at` reads back as `stale`. Both look exactly like the
// `no_projection` this route exists to end.
import { runtimeStateDoc, projectionEtag } from "../src/projection.js";

let bad = 0;
const check = (claim, ok, detail = "") => {
  if (ok) console.log(`  ok    ${claim}`);
  else { bad++; console.log(`  FAIL  ${claim}\n          ${detail}`); }
};

const base = {
  sessionId: "sess-1", epoch: "boot-1", seq: 7,
  sessions: [{ id: "sess-1", title: "a session" }],
  busy: false,
  model: { id: "deepseek-v4-flash", provider: "openrouter" },
  skills: [{ name: "git" }, { name: "docs" }],
  builtAt: 1788900000000,
};

{
  const d = runtimeStateDoc(base);
  check("the identity names the SESSION, which is what the pin is compared against",
    d.identity.opencode_session_id === "sess-1", JSON.stringify(d.identity));
  check("built_at is an ISO instant — a projection with no age reads as stale",
    d.built_at === new Date(1788900000000).toISOString(), d.built_at);
  check("the cursor the stream hands out travels with it",
    d.epoch === "boot-1" && d.seq === 7, `${d.epoch}/${d.seq}`);
  check("a cell claims no daemon build and no agent-config etag rather than inventing them",
    d.identity.daemon_build === null && d.identity.agent_config_etag === null, JSON.stringify(d.identity));
}

{
  const d = runtimeStateDoc(base);
  check("the roster carries the model the web client's agent list reads",
    d.agents.known === true && d.agents.value[0].model.providerID === "openrouter"
      && d.agents.value[0].model.modelID === "deepseek-v4-flash",
    JSON.stringify(d.agents));
  check("the session list is the one the cell already serves",
    d.sessions.known === true && d.sessions.value[0].id === "sess-1", JSON.stringify(d.sessions));
  check("an idle cell says idle, keyed by session",
    d.statuses.value["sess-1"].type === "idle", JSON.stringify(d.statuses));
  check("and a cell mid-turn says busy — this is what shows the Stop button",
    runtimeStateDoc({ ...base, busy: true }).statuses.value["sess-1"].type === "busy", "");
}

{
  // KNOWN IS NOT A DEFAULT. `known: true` with an empty array is a claim that
  // there are none. That is true of a cell's permissions and false of its
  // commands, and the difference is the whole point of the wrapper.
  const d = runtimeStateDoc(base);
  check("commands are UNKNOWN with a reason — a cell has skills, not a palette",
    d.commands.known === false && typeof d.commands.reason === "string" && d.commands.reason.length > 0,
    JSON.stringify(d.commands));
  check("permissions are KNOWN and empty — a cell never asks for one",
    d.permissions.known === true && d.permissions.value.length === 0, JSON.stringify(d.permissions));
  check("questions likewise",
    d.questions.known === true && d.questions.value.length === 0, JSON.stringify(d.questions));
  check("the skills the cell loaded are reported in config, by name",
    d.config.known === true && d.config.value.skills.join(",") === "git,docs", JSON.stringify(d.config));
  check("a cell whose workspace failed to load still produces a document",
    runtimeStateDoc({ ...base, skills: undefined }).config.value.skills.length === 0, "");
}

{
  // The etag decides whether a session open writes a new row every time.
  const a = runtimeStateDoc(base);
  const b = runtimeStateDoc({ ...base, builtAt: base.builtAt + 60_000 });
  check("the etag ignores built_at, so an unchanged cell answers 304 rather than storing again",
    projectionEtag(a) === projectionEtag(b), `${projectionEtag(a)} vs ${projectionEtag(b)}`);
  check("but it moves when the cell does",
    projectionEtag(a) !== projectionEtag(runtimeStateDoc({ ...base, busy: true })), "busy did not change the etag");
  check("and when the model does",
    projectionEtag(a) !== projectionEtag(runtimeStateDoc({ ...base, model: { id: "other", provider: "openrouter" } })), "");
  check("it is a WEAK etag — the body is regenerated per read and is not byte-stable",
    /^W\/"/.test(projectionEtag(a)), projectionEtag(a));
}

console.log(bad ? `\n  ${bad} failed` : "");
process.exit(bad ? 1 : 0);
