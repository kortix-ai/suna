import { describe, expect, test } from "bun:test";

import { CONFIGURE_KINDS, newConfigPrompt } from "./configure-prompts";

describe("newConfigPrompt", () => {
  test("the agent prompt asks what to build, names the config path, and asks for a change request", () => {
    const prompt = newConfigPrompt("agent");
    expect(prompt.startsWith("I want to configure a new agent for this project.")).toBe(true);
    expect(prompt).toContain("`agents/<name>.md`");
    expect(prompt).toContain("`file: agents/<name>.md`");
    expect(prompt).toContain("open a change request");
  });

  test("every kind has its own non-empty prompt", () => {
    const prompts = CONFIGURE_KINDS.map((kind) => newConfigPrompt(kind));
    for (const prompt of prompts) expect(prompt.length).toBeGreaterThan(0);
    expect(new Set(prompts).size).toBe(CONFIGURE_KINDS.length);
  });
});
