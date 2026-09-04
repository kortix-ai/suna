// THE SCRIPTED MODEL AND THE BUILD — the two things every other suite trusts.
//
// Every deterministic claim in this repo is driven by scriptedStream. If it
// emitted the wrong event shape, or ran turns out of order, the suites would
// still pass while testing something other than what they say. A fixture nothing
// checks is a fixture that can quietly lie for everyone.
//
// And build.mjs chooses between two provider sets by rewriting one bare
// specifier. A mistake there is invisible until someone flips a config value —
// the build succeeds, the wrong providers ship.
// Read by test/all.sh. The suite's own tail line catches a section that ran
// and produced nothing; it cannot catch an exit partway through, which skips
// the tail entirely. This is the number that check compares against.
// EXPECTED_PASSES=15

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { scriptedStream } from "../src/scripted.js";
import { watchClaims } from "../../tools/crash-reporter.mjs";

const HERE = new URL(".", import.meta.url).pathname;
let bad = 0;
const check = watchClaims((name, cond, detail = "") => {
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); bad++; }
});

const drain = async (stream) => {
  const events = [];
  for await (const e of stream) events.push(e);
  return { events, final: await stream.result() };
};
const MODEL = { id: "scripted", api: "anthropic-messages", provider: "scripted" };

// ── a text turn ─────────────────────────────────────────────────────────────
{
  const fn = scriptedStream([{ text: "hello there" }]);
  const { events, final } = await drain(await fn(MODEL, { messages: [] }));
  const types = events.map((e) => e.type);
  check("a text turn starts, streams and finishes",
    types[0] === "start" && types.includes("text_end") && types.at(-1) === "done", types.join(","));
  check("the final message carries the text",
    final.content.some((b) => b.type === "text" && b.text === "hello there"), JSON.stringify(final.content));
  check("a text turn stops rather than asking for a tool", final.stopReason === "stop", final.stopReason);
}

// ── a tool turn ─────────────────────────────────────────────────────────────
{
  const fn = scriptedStream([{ tool: "bash", id: "fixed-id", args: { command: "true" } }]);
  const { events, final } = await drain(await fn(MODEL, { messages: [] }));
  check("a tool turn emits toolcall_start and toolcall_end",
    events.some((e) => e.type === "toolcall_start") && events.some((e) => e.type === "toolcall_end"),
    events.map((e) => e.type).join(","));
  const call = final.content.find((b) => b.type === "toolCall");
  check("the tool call carries name and arguments",
    call?.name === "bash" && call.arguments.command === "true", JSON.stringify(call));
  check("stopReason is toolUse, or the agent loop would not run the tool",
    final.stopReason === "toolUse", final.stopReason);
  // THE ID IS THE IDEMPOTENCY KEY. If the script's id were ignored, every replay
  // would mint a new one and the ledger would protect nothing.
  check("an explicit id is honoured, which is what makes replays testable",
    call?.id === "fixed-id", call?.id);
}

// ── ordering and termination ────────────────────────────────────────────────
{
  const fn = scriptedStream([{ text: "one" }, { text: "two" }, { text: "three" }]);
  const seen = [];
  for (let i = 0; i < 3; i++) {
    const { final } = await drain(await fn(MODEL, { messages: [] }));
    seen.push(final.content.find((b) => b.type === "text")?.text);
  }
  check("turns are consumed in order", seen.join(",") === "one,two,three", seen.join(","));

  // A scripted model that never stops is an infinite bill in the shape of a test.
  const { final } = await drain(await fn(MODEL, { messages: [] }));
  check("running past the end terminates instead of looping",
    final.stopReason === "stop" && final.content.length > 0, JSON.stringify(final.content));
}

// ── the build's provider selection ──────────────────────────────────────────
{
  const cfgPath = `${HERE}../agent.config.json`;
  const original = readFileSync(cfgPath, "utf8");
  const cfg = JSON.parse(original);
  const build = (set) => {
    cfg.model.providers = set;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
    const out = execFileSync("npm", ["run", "--silent", "build"], { cwd: `${HERE}..`, encoding: "utf8" });
    const bundle = readFileSync(`${HERE}../dist/worker.js`, "utf8");
    return { out, bundle };
  };
  try {
    const slim = build("slim");
    check("a slim build says so", /providers: slim/.test(slim.out), slim.out.trim().slice(-60));
    check("a slim bundle does NOT carry the whole catalogue",
      !slim.bundle.includes("builtinProviders"), "builtinProviders found in a slim bundle");

    const all = build("all");
    check("an `all` build says so", /providers: all/.test(all.out), all.out.trim().slice(-60));
    check("an `all` bundle DOES carry the catalogue", all.bundle.includes("builtinProviders"));
    check("the two builds differ in size, so the choice is real",
      Math.abs(all.bundle.length - slim.bundle.length) > 100_000,
      `${slim.bundle.length} vs ${all.bundle.length}`);

    // A typo must not silently pick a set.
    const typo = build("aall");
    check("an unrecognised value falls back to the DEFAULT rather than failing open",
      /providers: all/.test(typo.out), typo.out.trim().slice(-60));
  } finally {
    writeFileSync(cfgPath, original);
    execFileSync("npm", ["run", "--silent", "build"], { cwd: `${HERE}..` });
  }
}

console.log(bad ? `\n  ${bad} failure(s)` : "\n  the fixture and the build hold");
process.exit(bad ? 1 : 0);
