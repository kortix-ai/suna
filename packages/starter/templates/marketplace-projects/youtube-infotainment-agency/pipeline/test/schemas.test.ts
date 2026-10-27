import { describe, expect, test } from "bun:test";
import { Brief, Claims, Package, Script, Storyboard } from "../src/schemas";
import { fixture } from "./helpers";

describe("schemas accept the fixture episode", () => {
  test.each([
    ["01-brief.json", Brief],
    ["02-research/claims.json", Claims],
    ["03-script/script.json", Script],
    ["04-visual/storyboard.json", Storyboard],
    ["07-package/package.json", Package],
  ] as const)("%s", (file, schema) => {
    const res = (schema as any).safeParse(fixture(file));
    expect(res.success).toBe(true);
  });
});

describe("schemas reject broken artifacts", () => {
  test("claim citing an unknown source", () => {
    const c = fixture<any>("02-research/claims.json");
    c.claims[0].source_ids = ["s99"];
    expect(Claims.safeParse(c).success).toBe(false);
  });
  test("duplicate beat ids", () => {
    const s = fixture<any>("03-script/script.json");
    s.beats[1].id = "b01";
    expect(Script.safeParse(s).success).toBe(false);
  });
  test("brief without an angle", () => {
    const b = fixture<any>("01-brief.json");
    b.originality.our_angle = "";
    expect(Brief.safeParse(b).success).toBe(false);
  });
});
