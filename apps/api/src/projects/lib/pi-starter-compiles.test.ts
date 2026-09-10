/**
 * The pi starter kit must COMPILE, not merely scaffold.
 *
 * `packages/starter` can assert its own files agree with each other, but it
 * cannot import the compiler — so nothing there proves the files this API
 * hands a new project are the files this API can then read back. This test
 * closes that loop: take the exact bytes `getStarterFiles({template:'pi'})`
 * emits, run them through the real compiler, and assert the pi worker gets a
 * usable bundle.
 *
 * What breaks without it: rename the agent, move the directory, or change the
 * version default, and every new pi project still scaffolds and still starts —
 * the agent just boots with the runtime's stock prompt instead of the one in
 * the repo. Silent, and invisible until someone reads an answer that sounds
 * wrong.
 */
import { describe, expect, test } from 'bun:test';
import { parseManifestText } from '@kortix/manifest-schema';
import { getStarterFiles } from '@kortix/starter';
import { agentMarkdownPath, compileAgentConfig } from './compile-agent-config';

const files = new Map(
  getStarterFiles({ projectName: 'Compile Probe', template: 'pi' }).map((f) => [f.path, f.content]),
);
const manifest = parseManifestText(files.get('kortix.yaml')!, 'yaml') as Record<string, unknown>;

describe('the pi starter kit compiles to a pi runtime bundle', () => {
  test('the compiler looks for each agent exactly where the kit put it', () => {
    for (const name of Object.keys(manifest.agents as Record<string, unknown>)) {
      const path = agentMarkdownPath(manifest, name);
      expect(path).toBe(`.kortix/pi/agents/${name}.md`);
      expect(files.has(path)).toBe(true);
    }
  });

  test("the agent's .md body becomes the worker's system prompt", () => {
    const md: Record<string, string> = {};
    for (const [path, content] of files) {
      if (path.startsWith('.kortix/pi/agents/')) md[path] = content;
    }
    // The same call the pi path makes: `compiled-pi-runtime-artifact.ts` goes
    // through `resolveCompiledAgentConfigForSession`, which compiles with the
    // DEFAULT runtime and then narrows to one agent. See the runtime-shape
    // test below for why that is 'opencode' and not 'pi'.
    const compiled = compileAgentConfig(manifest, 'opencode', md) as {
      agent: Record<string, { prompt?: string; description?: string }>;
    };
    expect(compiled).not.toBeNull();

    const defaultAgent = manifest.default_agent as string;
    const block = compiled.agent[defaultAgent];
    expect(block).toBeDefined();
    // `main.ts` does: `if (!KORTIX_SYSTEM_PROMPT && agent?.prompt) systemPrompt = agent.prompt`.
    // A missing or empty prompt here is the silent-stock-persona failure.
    expect(typeof block!.prompt).toBe('string');
    expect(block!.prompt!.length).toBeGreaterThan(200);
    expect(block!.prompt).toContain('Compile Probe');
    expect(block!.prompt).not.toContain('{{projectName}}');
    // Frontmatter is config, not prompt — it must not leak into the body.
    expect(block!.prompt!.startsWith('---')).toBe(false);
    expect(block!.description).toBeTruthy();
  });

  // A pi bundle carries an OPENCODE-SHAPED agent config: `main.ts` reads
  // `compiled.agentConfig.agent[name].prompt/.model`, which is that shape. The
  // compiler's `runtime` argument names the OUTPUT SHAPE, not the runtime that
  // will execute it — so passing 'pi' is rejected, and the pi artifact builder
  // correctly never passes it. Pinned because "compile the pi config with 'pi'"
  // is the obvious wrong guess, and it throws at artifact-build time where the
  // failure reads as a broken project rather than a wrong argument.
  test("the compiler's runtime arg is the output SHAPE — 'pi' is not one", () => {
    expect(() => compileAgentConfig(manifest, 'pi', {})).toThrow(/Unsupported compiler runtime/);
  });

  // Narrowing is what makes one artifact carry one agent. If the default agent
  // is not a key of the compiled map, the narrow silently keeps the full config
  // and the box boots whatever `Object.keys(agents)[0]` happens to be.
  test('the default agent survives the one-agent narrowing the artifact does', () => {
    const md: Record<string, string> = {};
    for (const [path, content] of files) {
      if (path.startsWith('.kortix/pi/agents/')) md[path] = content;
    }
    const compiled = compileAgentConfig(manifest, 'opencode', md) as {
      agent: Record<string, unknown>;
    };
    const baked = manifest.default_agent as string;
    expect(compiled.agent[baked]).toBeDefined();
    const narrowed = { ...compiled, agent: { [baked]: compiled.agent[baked] } };
    expect(Object.keys(narrowed.agent)).toEqual([baked]);
  });
});
