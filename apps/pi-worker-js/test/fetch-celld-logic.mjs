// Read by test/all.sh. The suite's own tail line catches a section that ran
// and produced nothing; it cannot catch an exit partway through, which skips
// the tail entirely. This is the number that check compares against.
// EXPECTED_PASSES=6

import { watchClaims } from "../../tools/crash-reporter.mjs";
// THE PINNED celld IS REFUSED UNLESS IT IS THE PINNED celld.
//
// test/fetch-celld.mjs puts a binary from the network on the path the e2e
// suite executes. Every way that can go wrong has to end in "no binary"
// (session-e2e SKIPPED by name) or a refusal — never in running bytes nobody
// checked. No network here: every response is a fake.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchCelld } from "./fetch-celld.mjs";

let bad = 0, claims = 0;
const check = watchClaims((n, c, d = "") => { claims++; if (c) console.log(`  ok    ${n}`); else { console.log(`  FAIL  ${n}${d ? `\n          ${d}` : ""}`); bad++; } });
const fresh = () => mkdtempSync(join(tmpdir(), "fetch-celld-"));
const counting = (respond) => { const f = async (...a) => { f.calls++; return respond(...a); }; f.calls = 0; return f; };

{
  const f = counting(() => new Response("x"));
  const r = await fetchCelld({ platform: "win32-x64", cacheDir: fresh(), fetch: f });
  check("a platform with no pinned asset gets no binary, a reason naming it, and no request", r.path === null && /win32-x64/.test(r.reason) && f.calls === 0, JSON.stringify(r));
}
{
  const dir = fresh();
  const r = await fetchCelld({ platform: "linux-x64", cacheDir: dir, fetch: counting(() => new Response("gone", { status: 404 })) });
  check("a release that answers 404 gives no binary and writes nothing", r.path === null && /404/.test(r.reason) && readdirSync(dir).length === 0, JSON.stringify(r));
}
{
  const r = await fetchCelld({ platform: "linux-x64", cacheDir: fresh(), fetch: counting(() => { throw new Error("ENOTFOUND github.com"); }) });
  check("no network gives no binary, so session-e2e is skipped by name instead of failing", r.path === null && /ENOTFOUND/.test(r.reason), JSON.stringify(r));
}
{
  const dir = fresh();
  let threw = "";
  try { await fetchCelld({ platform: "linux-x64", cacheDir: dir, fetch: counting(() => new Response(Buffer.from("not celld"))) }); }
  catch (error) { threw = error.message; }
  check("bytes that do not hash to the pinned sha256 are refused before anything is written",
    /refusing/.test(threw) && /79a8253cff5d4e8a/.test(threw) && !existsSync(join(dir, "celld")), threw);
}
{
  const dir = fresh();
  const bin = Buffer.from("#!/bin/sh\necho celld\n");
  writeFileSync(join(dir, "celld"), bin);
  writeFileSync(join(dir, "celld.sha256"), `${createHash("sha256").update(bin).digest("hex")}\n`);
  const f = counting(() => new Response("never", { status: 500 }));
  const r = await fetchCelld({ platform: "linux-x64", cacheDir: dir, fetch: f });
  check("a cached binary that still matches its stamp is reused without a request", r.path === join(dir, "celld") && r.reason === "cached" && f.calls === 0, JSON.stringify(r));
  writeFileSync(join(dir, "celld"), Buffer.from("#!/bin/sh\necho tampered\n"));
  const again = await fetchCelld({ platform: "linux-x64", cacheDir: dir, fetch: f });
  check("a cached binary changed after it was unpacked is not trusted: the fetcher goes back to the release", again.path === null && f.calls === 1, JSON.stringify(again));
}

console.log(bad ? `\n${bad} of ${claims} claims failed` : "\nall claims hold");
process.exit(bad ? 1 : 0);
