import { describe, expect, test } from "bun:test";

import {
  attachCompiledRuntimeIdentity,
  discoverRuntimeProjectFiles,
  resolveConfigAgents,
} from "../projects/git/config";
import { compileRuntimeConfig } from "../projects/lib/compile-runtime-config";
import type { LoadedAgents } from "../projects/agents";

const nativeAgents = [
  {
    name: "kortix",
    path: ".kortix/opencode/agents/kortix.md",
    description: "Default Kortix agent",
    mode: "primary",
  },
  {
    name: "release-bot",
    path: ".kortix/opencode/agents/release-bot.md",
    description: "Ships releases",
    mode: "subagent",
  },
];

describe("project config agent discovery", () => {
  test("no agents: keeps native runtime discovery", () => {
    const result = resolveConfigAgents(nativeAgents, { specs: [], errors: [] });

    expect(result.agent_source).toBe("native");
    expect(result.agent_discovery).toBe("runtime");
    expect("open_code_raw" in result).toBe(false);
    expect("open_code_default_agent" in result).toBe(false);
    expect(result.agents).toEqual([
      { ...nativeAgents[0], source: "runtime", enabled: true },
      { ...nativeAgents[1], source: "runtime", enabled: true },
    ]);
  });

  test("agents: becomes the launchable server-side roster", () => {
    const loaded: LoadedAgents = {
      errors: [],
      specs: [
        {
          name: "kortix",
          path: "kortix.yaml#agents.kortix",
          enabled: true,
          connectors: "all",
          kortixCli: "all",
          env: "all",
          file: null,
          model: null,
        },
        {
          name: "triage",
          path: "kortix.yaml#agents.triage",
          enabled: true,
          connectors: [],
          kortixCli: [],
          env: "all",
          file: ".kortix/opencode/agents/release-bot.md",
          model: null,
        },
        {
          name: "disabled",
          path: "kortix.yaml#agents.disabled",
          enabled: false,
          connectors: [],
          kortixCli: [],
          env: "all",
          file: null,
          model: null,
        },
      ],
    };

    const result = resolveConfigAgents(nativeAgents, loaded);

    expect(result.agent_discovery).toBe("declarative");
    expect(result.agent_source).toBe("declarative");
    expect(result.agents).toEqual([
      {
        name: "kortix",
        path: ".kortix/opencode/agents/kortix.md",
        description: "Default Kortix agent",
        mode: "primary",
        source: "kortix.yaml",
        enabled: true,
        scope: { env: "all", connectors: "all", kortix_cli: "all" },
      },
      {
        name: "triage",
        path: ".kortix/opencode/agents/release-bot.md",
        description: "Ships releases",
        mode: "subagent",
        source: "kortix.yaml",
        enabled: true,
        scope: { env: "all", connectors: [], kortix_cli: [] },
      },
    ]);
  });

  test("per-agent env/connectors/CLI allowlists surface as read-only scope", () => {
    const loaded: LoadedAgents = {
      errors: [],
      specs: [
        {
          name: "support_bot",
          path: "kortix.yaml#agents.support_bot",
          enabled: true,
          connectors: ["stripe"],
          kortixCli: ["project.read"],
          env: ["GITHUB_TOKEN", "OPENAI_API_KEY"],
          file: null,
          model: null,
        },
      ],
    };

    const [agent] = resolveConfigAgents(nativeAgents, loaded).agents;
    // The UI reads exactly this to render the per-agent scope panel — note the
    // wire key is `kortix_cli` (snake_case), mapped from the spec's `kortixCli`.
    expect(agent?.scope).toEqual({
      env: ["GITHUB_TOKEN", "OPENAI_API_KEY"],
      connectors: ["stripe"],
      kortix_cli: ["project.read"],
    });
  });

  test("native runtime-discovered agents carry no agents: scope", () => {
    const result = resolveConfigAgents(nativeAgents, { specs: [], errors: [] });
    expect(result.agents.every((a) => a.scope === undefined)).toBe(true);
  });

  test("surfaces the compiler-resolved runtime and harness on every logical agent", () => {
    const loaded: LoadedAgents = {
      errors: [],
      specs: [
        {
          name: "reviewer",
          path: "kortix.yaml#agents.reviewer",
          enabled: true,
          connectors: "all",
          kortixCli: "all",
          env: "all",
          file: null,
          model: null,
        },
      ],
    };
    const compiled = compileRuntimeConfig({
      kortix_version: 3,
      default_agent: "reviewer",
      runtimes: { code: { harness: "codex" } },
      agents: { reviewer: { runtime: "code" } },
    });
    const agents = attachCompiledRuntimeIdentity(
      resolveConfigAgents(nativeAgents, loaded).agents,
      compiled,
    );
    expect(agents[0]).toMatchObject({
      name: "reviewer",
      runtime: "code",
      harness: "codex",
    });
  });

  test("discovers native config, agents, skills, and commands for every v3 harness", () => {
    const compiled = compileRuntimeConfig({
      kortix_version: 3,
      default_agent: "claude-reviewer",
      runtimes: {
        claude: { harness: "claude", config_dir: ".claude" },
        codex: { harness: "codex", config_dir: ".codex" },
        opencode: { harness: "opencode", config_dir: ".kortix/opencode" },
        pi: { harness: "pi", config_dir: ".pi" },
      },
      agents: {
        "claude-reviewer": { runtime: "claude", agent: "reviewer" },
        "codex-reviewer": { runtime: "codex", agent: "reviewer" },
        open: { runtime: "opencode", agent: "kortix" },
        pi: { runtime: "pi", agent: "writer" },
      },
    });
    expect(discoverRuntimeProjectFiles(compiled, [
      ".claude/settings.json",
      ".claude/agents/reviewer.md",
      ".claude/skills/pdf/SKILL.md",
      ".claude/commands/audit.md",
      ".codex/config.toml",
      ".codex/reviewer.config.toml",
      ".agents/skills/review/SKILL.md",
      ".kortix/opencode/opencode.jsonc",
      ".kortix/opencode/agents/kortix.md",
      ".kortix/opencode/commands/ship.md",
      ".pi/settings.json",
      ".pi/prompts/writer.md",
      ".pi/skills/research/SKILL.md",
    ])).toMatchObject({
      configs: [
        { runtime: "claude", harness: "claude", path: ".claude/settings.json" },
        { runtime: "codex", harness: "codex", path: ".codex/config.toml" },
        { runtime: "opencode", harness: "opencode", path: ".kortix/opencode/opencode.jsonc" },
        { runtime: "pi", harness: "pi", path: ".pi/settings.json" },
      ],
      agents: expect.arrayContaining([
        expect.objectContaining({ harness: "claude", nativeName: "reviewer", path: ".claude/agents/reviewer.md" }),
        expect.objectContaining({ harness: "codex", nativeName: "reviewer", path: ".codex/reviewer.config.toml" }),
        expect.objectContaining({ harness: "opencode", nativeName: "kortix", path: ".kortix/opencode/agents/kortix.md" }),
        expect.objectContaining({ harness: "pi", nativeName: "writer", path: ".pi/prompts/writer.md" }),
      ]),
      skills: expect.arrayContaining([
        expect.objectContaining({ slug: "pdf", path: ".claude/skills/pdf/SKILL.md" }),
        expect.objectContaining({ slug: "review", path: ".agents/skills/review/SKILL.md" }),
        expect.objectContaining({ slug: "research", path: ".pi/skills/research/SKILL.md" }),
      ]),
      commands: expect.arrayContaining([
        expect.objectContaining({ slug: "audit", path: ".claude/commands/audit.md" }),
        expect.objectContaining({ slug: "ship", path: ".kortix/opencode/commands/ship.md" }),
      ]),
    });
  });

  test("invalid agents: adoption disables legacy discovery instead of silently exposing all agents", () => {
    const result = resolveConfigAgents(nativeAgents, {
      specs: [],
      errors: [
        {
          name: "(top-level)",
          path: "kortix.yaml",
          error: "`agents` must use [[agents]]",
        },
      ],
    });

    expect(result.agent_discovery).toBe("declarative");
    expect(result.agent_source).toBe("declarative");
    expect(result.agents).toEqual([]);
  });
});
