import { describe, expect, test } from "bun:test";
import { applyFactCheck } from "../src/claims";
import { Claims, FactCheck, Script } from "../src/schemas";
import { estimateSeconds, lintScript, scriptMarkdown, stripTags, words } from "../src/script";
import { fixture } from "./helpers";

const claims = () => Claims.parse(fixture("02-research/claims.json"));
const verified = () => applyFactCheck(claims(), FactCheck.parse(fixture("02-research/fact-check.json"))).claims;
const script = () => Script.parse(fixture("03-script/script.json"));

describe("text utils", () => {
  test("audio tags are not words", () => {
    expect(stripTags("[curious] Look up. [short pause] Why?")).toBe("Look up. Why?");
    expect(words("[whispers] Hello, world — 42!")).toEqual(["Hello,", "world", "42!"]);
  });
  test("duration estimate", () => {
    expect(estimateSeconds("one two three four five", 150)).toBeCloseTo(2, 5);
  });
});

describe("fact-check merge", () => {
  test("verdicts map onto claim status", () => {
    const fc = FactCheck.parse(fixture("02-research/fact-check.json"));
    fc.results[1]!.verdict = "partially_supported";
    fc.results[2]!.verdict = "unsupported";
    const { claims: c, summary } = applyFactCheck(claims(), fc);
    expect(c.claims.map((x) => x.status)).toEqual(["verified", "disputed", "rejected"]);
    expect(summary).toMatchObject({ verified: 1, disputed: 1, rejected: 1 });
  });
  test("unchecked claims stay unverified", () => {
    const fc = FactCheck.parse(fixture("02-research/fact-check.json"));
    fc.results = fc.results.slice(0, 1);
    expect(applyFactCheck(claims(), fc).summary.unverified).toBe(2);
  });
  test("a claim reworded after its check goes back to unverified, and is named", () => {
    const fc = FactCheck.parse(fixture("02-research/fact-check.json"));
    const c = claims();
    fc.results = fc.results.map((r) => ({ ...r, claim_text: c.claims.find((x) => x.id === r.claim_id)!.text }));
    c.claims[1]!.text = `${c.claims[1]!.text} (reworded after the check)`;
    const { claims: out, summary, stale } = applyFactCheck(c, fc);
    expect(out.claims[1]!.status).toBe("unverified");
    expect(out.claims[0]!.status).toBe("verified");
    expect(stale).toEqual([c.claims[1]!.id]);
    expect(summary.unverified).toBe(1);
  });
});

describe("script lint", () => {
  test("fixture is clean once claims are verified", () => {
    const { issues, stats } = lintScript(script(), verified());
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    expect(stats.cited_claims).toBe(3);
  });
  test("citing an unverified claim is an error", () => {
    const { issues } = lintScript(script(), claims());
    expect(issues.some((i) => i.level === "error" && /not verified/.test(i.msg))).toBe(true);
  });
  test("a fact beat must cite something", () => {
    const s = script();
    s.beats[1]!.claims = [];
    expect(lintScript(s, verified()).issues.some((i) => /cites no claim/.test(i.msg))).toBe(true);
  });
  test("emphasis words must be spoken", () => {
    const s = script();
    s.beats[0]!.emphasis = ["purple"];
    expect(lintScript(s, verified()).issues.some((i) => /emphasis/.test(i.msg))).toBe(true);
  });
  test("must open with a hook", () => {
    const s = script();
    s.beats[0]!.act = "setup";
    expect(lintScript(s, verified()).issues.some((i) => /hook/.test(i.msg))).toBe(true);
  });
});

describe("script.md", () => {
  test("a claim cites every source behind it, not only the first", () => {
    const c = verified();
    const claim = c.claims.find((x) => script().beats.some((b) => b.claims.includes(x.id)))!;
    const [a, b] = c.sources;
    claim.source_ids = [a!.id, b!.id];
    const md = scriptMarkdown(script(), c);
    const line = md.split("\n").find((l) => l.includes(`\`${claim.id}\``))!;
    expect(line).toContain(`[${a!.publisher}](${a!.url})`);
    expect(line).toContain(`[${b!.publisher}](${b!.url})`);
  });
});
