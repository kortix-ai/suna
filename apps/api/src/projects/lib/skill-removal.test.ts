import {
  parseManifestText,
  resolveManifestImportsSync,
} from "@kortix/manifest-schema";
import { manifestWrites } from "../manifest-io";
import { describe, expect, test } from "bun:test";
import { planSkillRemoval } from "./skill-removal";

describe("selected project skill removal", () => {
  test("removes edited folder contents and explicit grants, preserving shared assets", () => {
    const raw = {
      kortix_version: 3,
      skills: { pdf: "skills/pdf", other: "skills/other" },
      agents: {
        helper: { skills: ["pdf", "other"], tools: ["shared"] },
        empty: { skills: ["pdf"] },
        all: { skills: "all" },
      },
      secrets: { shared: {} },
    };
    const plan = planSkillRemoval(
      raw,
      [
        "skills/pdf/SKILL.md",
        "skills/pdf/custom/script.py",
        "skills/pdf-extra/SKILL.md",
        "skills/other/SKILL.md",
        "tools/shared.ts",
      ],
      "skills/pdf",
    );
    expect(plan.deletes).toEqual([
      "skills/pdf/SKILL.md",
      "skills/pdf/custom/script.py",
    ]);
    expect(plan.raw).toEqual({
      ...raw,
      skills: { other: "skills/other" },
      agents: {
        helper: { skills: ["other"], tools: ["shared"] },
        empty: { skills: [] },
        all: { skills: "all" },
      },
    });
    expect(raw.skills.pdf).toBe("skills/pdf");
  });
  test("drops the removed skill from an { exclude } grant", () => {
    const raw = {
      kortix_version: 3,
      skills: { pdf: "skills/pdf" },
      agents: { helper: { skills: { exclude: ["pdf", "kortix-goals"] } } },
    };
    const plan = planSkillRemoval(raw, ["skills/pdf/SKILL.md"], "skills/pdf");
    expect((plan.raw.agents as Record<string, unknown>).helper).toEqual({ skills: { exclude: ["kortix-goals"] } });
  });
  test("requires an exact installed folder and refuses traversal, managed and shared paths", () => {
    for (const folder of [
      "skills",
      "../skills/pdf",
      "/skills/pdf",
      "skills//pdf",
      "skills/kortix-test",
      "tools/shared",
    ]) {
      expect(() =>
        planSkillRemoval(
          { kortix_version: 3 },
          ["skills/pdf/SKILL.md"],
          folder,
        ),
      ).toThrow();
    }
    expect(() =>
      planSkillRemoval(
        { kortix_version: 3 },
        ["skills/pdf/SKILL.md", "skills/pdf/nested/SKILL.md"],
        "skills/pdf",
      ),
    ).toThrow();
    expect(() =>
      planSkillRemoval(
        {
          kortix_version: 3,
          skills: { pdf: "skills/pdf", nested: "skills/pdf/nested" },
        },
        ["skills/pdf/SKILL.md"],
        "skills/pdf",
      ),
    ).toThrow();
  });
  test("supports legacy discovery but refuses shadowed skill identities", () => {
    expect(
      planSkillRemoval(
        { kortix_version: 2 },
        ["skills/pdf/SKILL.md"],
        "skills/pdf",
      ).deletes,
    ).toEqual(["skills/pdf/SKILL.md"]);
    expect(() =>
      planSkillRemoval(
        { kortix_version: 2 },
        ["skills/pdf/SKILL.md", ".kortix/opencode/skills/pdf/SKILL.md"],
        "skills/pdf",
      ),
    ).toThrow();
  });
});

test("removal writes imported registrations and grants back to their owning files", () => {
  const raw = { kortix_version: 3, imports: ["config/"] };
  const texts: Record<string, string> = {
    "config/skills.yaml": "skills:\n  pdf: skills/pdf\n",
    "config/agents.yaml": "agents:\n  helper:\n    skills: [pdf]\n",
  };
  const imports = resolveManifestImportsSync(
    { path: "kortix.yaml", raw },
    {
      list: () =>
        Object.keys(texts).map((path) => ({ path, revision: "observed" })),
      read: (path) => texts[path] ?? "",
    },
  );
  const plan = planSkillRemoval(
    imports.raw,
    ["skills/pdf/SKILL.md"],
    "skills/pdf",
  );
  const writes = manifestWrites({
    schemaVersion: 3,
    raw: plan.raw,
    format: "yaml",
    path: "kortix.yaml",
    revision: "root",
    imports,
  });
  const skillWrite = writes.files.find(
    (file) => file.path === "config/skills.yaml",
  );
  const agentWrite = writes.files.find(
    (file) => file.path === "config/agents.yaml",
  );
  expect(skillWrite).toBeDefined();
  expect(agentWrite).toBeDefined();
  expect(parseManifestText(skillWrite?.content ?? "", "yaml")).toEqual({
    skills: {},
  });
  expect(parseManifestText(agentWrite?.content ?? "", "yaml")).toEqual({
    agents: { helper: { skills: [] } },
  });
  expect(writes.alsoExpect).toHaveLength(2);
});
