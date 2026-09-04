// THE PROVIDER LAYER, without a network call or an API key.
//
// "39 providers work in a cell" is a claim with edges, and the edges are where
// it would actually hurt:
//
//   • a provider that CANNOT run in a cell (amazon-bedrock pulls the AWS SDK)
//     must refuse with a reason, not fail at the first token
//   • a model id the catalogue has never heard of must NOT throw — providers
//     ship models faster than a catalogue is regenerated, and a hard failure
//     there means a working model is unusable until someone updates a package
//   • base_url must win, or every OpenAI-compatible endpoint is unreachable
//
// Both provider sets are tested, because build.mjs picks between them and a
// mistake in the one you are not using is invisible until someone flips a config
// value.
// Read by test/all.sh. The suite's own tail line catches a section that ran
// and produced nothing; it cannot catch an exit partway through, which skips
// the tail entirely. This is the number that check compares against.
// EXPECTED_PASSES=29

import * as all from "../src/providers.all.js";
import * as slim from "../src/providers.slim.js";
import { watchClaims } from "../../tools/crash-reporter.mjs";

let bad = 0;
const check = watchClaims((name, cond, detail = "") => {
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); bad++; }
});
const threw = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

// ── the full catalogue ──────────────────────────────────────────────────────
const providers = all.listProviders();
check("the catalogue lists many providers", providers.length >= 30, `${providers.length}`);
check("bedrock is excluded, because it cannot run in a cell",
  !providers.includes("amazon-bedrock"), providers.filter((p) => p.includes("bedrock")).join(","));
for (const p of ["openai", "anthropic", "google", "openai-codex", "openrouter", "groq"]) {
  check(`the catalogue includes ${p}`, providers.includes(p));
}

// A known model carries the catalogue's real numbers, which is what makes the
// compaction threshold per-model without a table of our own.
const luna = all.lookupModel({ provider: "openai-codex", modelId: "gpt-5.6-luna" });
check("a known model carries its context window", luna.contextWindow > 100_000, `${luna.contextWindow}`);
check("a known model carries its cost", typeof luna.cost?.input === "number", JSON.stringify(luna.cost));
check("a known model carries its api", luna.api === "openai-codex-responses", luna.api);

const sonnet = all.lookupModel({ provider: "anthropic", modelId: "claude-sonnet-5" });
check("different models have different windows",
  sonnet.contextWindow !== luna.contextWindow, `${sonnet.contextWindow} vs ${luna.contextWindow}`);

// ── the edges ───────────────────────────────────────────────────────────────
const bedrock = threw(() => all.lookupModel({ provider: "amazon-bedrock", modelId: "x" }));
check("bedrock refuses with a REASON, not a generic error",
  bedrock && /AWS SDK/.test(bedrock) && /gateway/i.test(bedrock), bedrock ?? "did not throw");

const nonsense = threw(() => all.lookupModel({ provider: "not-a-provider", modelId: "x" }));
check("an unknown provider lists what is available",
  nonsense && /unknown provider/.test(nonsense) && nonsense.length > 60, (nonsense ?? "").slice(0, 80));

// THE ONE THAT MATTERS MOST for a catalogue that is a snapshot in time.
let unknownModel = null;
const fallback = (() => { try { return all.lookupModel({ provider: "openai", modelId: "gpt-6-does-not-exist-yet" }); } catch (e) { unknownModel = e.message; return null; } })();
check("an unknown MODEL id does not throw — the catalogue is a snapshot, not a gate",
  fallback !== null, unknownModel ?? "");
check("the fallback still has a usable api and baseUrl",
  fallback && fallback.api && fallback.baseUrl, JSON.stringify(fallback ?? {}).slice(0, 90));

const redirected = all.lookupModel({ provider: "openai", modelId: "gpt-5.1", baseUrl: "http://localhost:9999/v1" });
check("base_url overrides the catalogue's endpoint",
  redirected.baseUrl === "http://localhost:9999/v1", redirected.baseUrl);

check("a provider stream is a function", typeof all.streamFor("openai") === "function");
check("a stream for an unknown provider throws", threw(() => all.streamFor("nope")) !== null);

// ── the slim set ────────────────────────────────────────────────────────────
check("slim exposes exactly the three APIs", slim.listProviders().length === 3, slim.listProviders().join(","));
const slimMiss = threw(() => slim.lookupModel({ provider: "groq", modelId: "x" }));
check("slim refuses an unlisted provider and says how to reach it anyway",
  slimMiss && /slim set/.test(slimMiss) && /base_url/.test(slimMiss), (slimMiss ?? "").slice(0, 100));
const slimOk = slim.lookupModel({ provider: "openai", modelId: "anything", baseUrl: "http://gw/v1" });
check("slim honours base_url, so any OpenAI-compatible endpoint works",
  slimOk.baseUrl === "http://gw/v1" && slimOk.api === "openai-completions", JSON.stringify(slimOk).slice(0, 80));
check("slim's set name is reported", slim.SET_NAME === "slim" && all.SET_NAME === "all");

// ── a provider the slim bundle does not carry ──────────────────────────────
// Found by mutate-guards: removing this throw broke no claim. The slim bundle
// exists to keep the worker small, and asking it for a provider it does not
// carry must say so by name — returning an undefined stream would surface much
// later, and somewhere else, as "the model produced nothing".
{
  const slim = await import("../src/providers.slim.js");
  let threw = null;
  try { slim.streamFor("a-provider-that-is-not-bundled"); } catch (e) { threw = String(e?.message ?? e); }
  check("the slim bundle refuses a provider it does not carry, naming it",
    /not in the slim set/.test(threw ?? "") && /a-provider-that-is-not-bundled/.test(threw ?? ""),
    String(threw));
  check("and it still serves one it does carry",
    typeof slim.streamFor(slim.listProviders()[0]) === "function", slim.listProviders().join(","));
}

// ── the provider is loaded LAZILY, and once ─────────────────────────────────
// "Lazy, so a cell running the scripted model never initialises a provider."
// That is a cold-start claim: the slim set exists because 768 KB and 11 ms of
// first-cell startup are worth opting out of, and a streamFor() that imported
// eagerly would spend them on every cell whether or not a model is ever called.
//
// The memo is the second half. Without it the module is re-imported on every
// stream call — cheap after the first, since the loader caches, but an await
// per call in the hot path and a claim nobody could have made about it.
{
  const entry = slim.PROVIDER_APIS.openai;
  const realLoad = entry.load;
  let loads = 0;
  entry.load = async () => { loads++; return { streamSimple: async () => "STREAMED" }; };
  try {
    const stream = slim.streamFor("openai");
    check("streamFor does not load the provider — a scripted cell pays nothing for one it never calls",
      loads === 0, `${loads} loads`);
    const first = await stream({}, {}, {});
    check("the first call loads it", loads === 1 && first === "STREAMED", `${loads} loads, got ${first}`);
    const second = await stream({}, {}, {});
    check("and the second call reuses it rather than importing again",
      loads === 1 && second === "STREAMED", `${loads} loads`);
    // Each streamFor is its own memo, which is what keeps two providers from
    // sharing one loaded module.
    const other = slim.streamFor("openai");
    await other({}, {}, {});
    check("a separately built stream loads for itself, so the memo is per-stream not global",
      loads === 2, `${loads} loads`);
  } finally { entry.load = realLoad; }
}

console.log(bad ? `\n  ${bad} failure(s)` : "\n  the provider layer holds");
process.exit(bad ? 1 : 0);
