import { describe, expect, it } from 'bun:test';

import type { ProjectSessionRow } from './lib/serializers';
import {
  type GenerateSessionTitleOptions,
  extractPromptInfo,
  generateSessionTitleFromFirstPrompt,
  sanitizeGeneratedTitle,
  TITLE_SOURCE_MAX_CHARS,
  titleCompletionBody,
  titleSourceForCreate,
} from './session-title-generate';

function row(metadata: Record<string, unknown>): ProjectSessionRow {
  return {
    sessionId: 'sess-1',
    projectId: 'proj-1',
    accountId: 'acct-1',
    metadata,
  } as unknown as ProjectSessionRow;
}

function headers(contentType = 'application/json'): Headers {
  return new Headers({ 'content-type': contentType });
}

function bodyOf(value: unknown): ArrayBuffer {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('titleCompletionBody', () => {
  it('grants reasoning models enough completion budget to emit content', () => {
    const body = JSON.parse(titleCompletionBody('glm-5.3-flash', 'Create a demo PDF about cats.'));
    // Reasoning models (GLM, DeepSeek, o-series) spend tokens on `reasoning`
    // BEFORE `content`. A tight cap (the old 24) returned finish_reason
    // "length" with an empty content — and the session stayed untitled
    // forever. The floor here is the regression guard.
    expect(body.max_tokens).toBeGreaterThanOrEqual(128);
    expect(body.model).toBe('glm-5.3-flash');
    expect(body.stream).toBe(false);
    // The message is quoted as DATA inside a titling instruction — passed
    // bare, smaller models answer it (emit code) instead of titling it.
    expect(body.messages[1].content).toContain('Create a demo PDF about cats.');
    expect(body.messages[1].content).toMatch(/only the title/i);
    expect(body.messages[1].content).toMatch(/Do NOT answer/i);
  });

  it('truncates oversized prompt text', () => {
    const body = JSON.parse(titleCompletionBody('glm-5.3-flash', 'x'.repeat(TITLE_SOURCE_MAX_CHARS + 500)));
    expect(body.messages[1].content).not.toContain('x'.repeat(TITLE_SOURCE_MAX_CHARS + 1));
    expect(body.messages[1].content).toContain('x'.repeat(TITLE_SOURCE_MAX_CHARS));
  });
});

describe('sanitizeGeneratedTitle', () => {
  it.each([
    { raw: '  "Set Up  MS Graph"  ', title: 'Set Up MS Graph' },
    { raw: '"Cat  Demo\nPDF"', title: 'Cat Demo PDF' },
    { raw: '`Fix the login bug`', title: 'Fix the login bug' },
    { raw: 'line one\nline two', title: 'line one line two' },
  ])('cleans to "$title"', ({ raw, title }) => {
    expect(sanitizeGeneratedTitle(raw)).toBe(title);
  });

  it('caps a title at 64 characters', () => {
    expect(sanitizeGeneratedTitle('a'.repeat(200))).toHaveLength(64);
  });

  // An empty completion is what a reasoning-only response leaves behind. A
  // placeholder-shaped or code-fenced reply is a model answering the prompt
  // instead of titling it. None of them may become the title.
  it.each([
    { raw: '' },
    { raw: '   ' },
    { raw: null },
    { raw: 'New session - 2026-07-28' },
    { raw: 'New agent' },
    { raw: '```python\nimport subprocess\n```' },
  ])('rejects $raw', ({ raw }) => {
    expect(sanitizeGeneratedTitle(raw)).toBeNull();
  });
});

describe('extractPromptInfo', () => {
  it('reads REST { parts } text blocks and the kortix-namespace model', () => {
    const body = bodyOf({
      parts: [
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'world' },
      ],
      model: { providerID: 'kortix', modelID: 'codex/gpt-5.6-sol' },
    });
    expect(extractPromptInfo(body, headers())).toEqual({
      text: 'hello\nworld',
      model: 'codex/gpt-5.6-sol',
    });
  });

  it('keeps a BYOK provider pair and accepts a string model', () => {
    const byok = bodyOf({
      parts: [],
      model: { providerID: 'anthropic', modelID: 'claude-sonnet-4.6' },
    });
    expect(extractPromptInfo(byok, headers()).model).toBe('anthropic/claude-sonnet-4.6');
    expect(extractPromptInfo(bodyOf({ model: 'kortix/glm-5.3-flash' }), headers()).model).toBe('glm-5.3-flash');
  });

  it('ignores non-text blocks and non-json / empty bodies', () => {
    const withImage = bodyOf({
      parts: [
        { type: 'image', url: 'x' },
        { type: 'text', text: 'ok' },
      ],
    });
    expect(extractPromptInfo(withImage, headers())).toEqual({ text: 'ok', model: null });
    expect(extractPromptInfo(bodyOf({ parts: [] }), headers())).toEqual({
      text: null,
      model: null,
    });
    expect(extractPromptInfo(undefined, headers())).toEqual({ text: null, model: null });
    expect(
      extractPromptInfo(bodyOf({ parts: [{ type: 'text', text: 'x' }] }), headers('text/plain')),
    ).toEqual({ text: null, model: null });
  });
});

describe('titleSourceForCreate', () => {
  it('prefers an explicit title_source over the rendered prompt', () => {
    expect(
      titleSourceForCreate({ title_source: 'deploy the worker', initial_prompt: 'ENVELOPE…' }),
    ).toBe('deploy the worker');
  });

  it('falls back to initial_prompt / initialPrompt and trims', () => {
    expect(titleSourceForCreate({ initial_prompt: '  ship it  ' })).toBe('ship it');
    expect(titleSourceForCreate({ initialPrompt: 'ship it' })).toBe('ship it');
  });

  it('is null when the body carries neither, or only blanks', () => {
    expect(titleSourceForCreate({})).toBeNull();
    expect(titleSourceForCreate({ name: 'Fix sandbox build' })).toBeNull();
    expect(titleSourceForCreate({ title_source: '   ', initial_prompt: '' })).toBeNull();
    expect(titleSourceForCreate({ title_source: null, initial_prompt: 'fallback' })).toBe(
      'fallback',
    );
  });
});

describe('generateSessionTitleFromFirstPrompt', () => {
  function harness(over: Partial<GenerateSessionTitleOptions> & { row?: ProjectSessionRow } = {}) {
    const persisted: string[] = [];
    const minted: string[] = [];
    const revoked: string[] = [];
    const models: string[] = [];
    let generateCalls = 0;
    const options: GenerateSessionTitleOptions = {
      loadRow: async () =>
        over.row ?? row({ opencode_model: 'amazon-bedrock/jp.anthropic.claude-opus-5' }),
      generate:
        over.generate ??
        (async (model) => {
          generateCalls += 1;
          models.push(model);
          return '"Set Up MS Graph"';
        }),
      mintKey:
        over.mintKey ??
        (async () => {
          minted.push('k');
          return { secret: 'sk', keyId: 'key-1' };
        }),
      revokeKey:
        over.revokeKey ??
        (async (_p, keyId) => {
          revoked.push(keyId);
        }),
      persist:
        over.persist ??
        (async (_r, title) => {
          persisted.push(title);
        }),
      // Never let a unit test reach the real resolver (billing tier + gateway
      // candidate resolution, both DB-backed).
      fallbackModel: over.fallbackModel ?? (async () => null),
      // This suite exercises the GATEWAY titling path; the per-project flag is
      // resolved from the DB in production. Native-mode (flag off) behavior is
      // covered by its own cases below.
      resolveLlmGatewayEnabled: over.resolveLlmGatewayEnabled ?? (async () => true),
    };
    return { options, persisted, minted, revoked, models, generateCalls: () => generateCalls };
  }

  const input = {
    sessionId: 'sess-1',
    projectId: 'proj-1',
    accountId: 'acct-1',
    userId: 'user-1',
    firstPromptText: 'Please set up the MS Graph OAuth2 connector',
  };

  it('titles with the LIVE picked model (modelHint), not the stale opencode_model', async () => {
    const h = harness(); // row.opencode_model is the stale/broken bedrock default
    await generateSessionTitleFromFirstPrompt(
      { ...input, modelHint: 'codex/gpt-5.6-sol' },
      h.options,
    );
    expect(h.models).toEqual(['codex/gpt-5.6-sol']);
    expect(h.persisted).toEqual(['Set Up MS Graph']);
    expect(h.revoked).toEqual(['key-1']);
  });

  it('falls back to opencode_model, ahead of the resolved fallback, when the prompt carries no model', async () => {
    const h = harness({
      row: row({ opencode_model: 'kortix/glm-5.3-flash' }),
      fallbackModel: async () => 'never/used',
    });
    await generateSessionTitleFromFirstPrompt(input, h.options);
    expect(h.models).toEqual(['glm-5.3-flash']);
  });

  it('retries once with the servable fallback when the session model is rejected', async () => {
    const attempts: string[] = [];
    const h = harness({
      row: row({ opencode_model: 'anthropic/claude-opus-4-8' }),
      fallbackModel: async () => 'glm-5.3-flash',
      generate: async (model) => {
        attempts.push(model);
        return model === 'glm-5.3-flash' ? '"Fallback Title"' : null;
      },
    });

    await generateSessionTitleFromFirstPrompt(input, h.options);

    expect(attempts).toEqual(['anthropic/claude-opus-4-8', 'glm-5.3-flash']);
    expect(h.persisted).toEqual(['Fallback Title']);
    expect(h.minted).toEqual(['k']);
    expect(h.revoked).toEqual(['key-1']);
  });

  it('uses the first prompt as a deterministic title when both model attempts fail', async () => {
    const h = harness({
      row: row({ opencode_model: 'anthropic/claude-opus-4-8' }),
      fallbackModel: async () => 'glm-5.3-flash',
      generate: async () => null,
    });

    await generateSessionTitleFromFirstPrompt(input, h.options);

    expect(h.persisted).toEqual(['Please set up the MS Graph OAuth2 connector']);
    expect(h.revoked).toEqual(['key-1']);
  });

  it('never turns a placeholder-shaped first prompt back into the placeholder', async () => {
    const h = harness({ generate: async () => null });

    await generateSessionTitleFromFirstPrompt(
      { ...input, firstPromptText: 'New agent planning document' },
      h.options,
    );

    expect(h.persisted).toEqual(['Topic: New agent planning document']);
  });

  it(
    'bounds model attempts and uses the deterministic title when the gateway hangs',
    async () => {
      const h = harness({
        row: row({ opencode_model: 'anthropic/claude-opus-4-8' }),
        fallbackModel: async () => 'glm-5.3-flash',
        generate: async () => new Promise<string | null>(() => {}),
      });
      const options = { ...h.options, generationTimeoutMs: 5 } as GenerateSessionTitleOptions;

      await generateSessionTitleFromFirstPrompt(input, options);

      expect(h.persisted).toEqual(['Please set up the MS Graph OAuth2 connector']);
      expect(h.revoked).toEqual(['key-1']);
    },
    200,
  );

  it('is idempotent — skips a session that already has a real title', async () => {
    const h = harness({
      row: row({ name: 'Existing Title', opencode_model: 'codex/gpt-5.6-sol' }),
    });
    await generateSessionTitleFromFirstPrompt(input, h.options);
    expect(h.persisted).toEqual([]);
    expect(h.generateCalls()).toBe(0);
  });

  it('skips a user-named session (custom_name) but re-titles placeholder names', async () => {
    const custom = harness({
      row: row({ custom_name: 'My Name', opencode_model: 'codex/gpt-5.6-sol' }),
    });
    await generateSessionTitleFromFirstPrompt(input, custom.options);
    expect(custom.persisted).toEqual([]);

    const placeholder = harness({
      row: row({ name: 'New session - 2026-07-28', opencode_model: 'codex/gpt-5.6-sol' }),
    });
    await generateSessionTitleFromFirstPrompt(input, placeholder.options);
    expect(placeholder.persisted).toEqual(['Set Up MS Graph']);

    const agentPlaceholder = harness({
      row: row({ name: 'New agent', opencode_model: 'codex/gpt-5.6-sol' }),
    });
    await generateSessionTitleFromFirstPrompt(input, agentPlaceholder.options);
    expect(agentPlaceholder.persisted).toEqual(['Set Up MS Graph']);
  });

  it('falls back to a resolved SERVABLE model when neither the turn nor the row names one', async () => {
    // Create-time and every server-side delivery arrive with no modelHint, and
    // `opencode_model` is absent whenever session create resolved no default —
    // without this fallback those sessions would stay untitled forever.
    const h = harness({ row: row({}), fallbackModel: async () => 'glm-5.3-flash' });
    await generateSessionTitleFromFirstPrompt(input, h.options);
    expect(h.models).toEqual(['glm-5.3-flash']);
    expect(h.persisted).toEqual(['Set Up MS Graph']);
  });

  it('spends NOTHING when no model is servable — free tier, or no managed provider', async () => {
    // The unconditional platform default is a managed id: on a free tier (or a
    // deployment with no managed provider) the gateway refuses it. The prompt
    // excerpt still titles the session without minting a key or calling a model.
    const h = harness({ row: row({}), fallbackModel: async () => null });
    await generateSessionTitleFromFirstPrompt(input, h.options);
    expect(h.models).toEqual([]);
    expect(h.minted).toEqual([]);
    expect(h.persisted).toEqual(['Please set up the MS Graph OAuth2 connector']);
  });

  it('titles from the create-time title_source, never the rendered envelope it was handed', async () => {
    // A Slack/Teams/Telegram session bakes a rendered envelope as its prompt; a
    // later fallback hook only ever sees THAT text. Without the stored source, a
    // transient create-hook failure names the session after turn instructions
    // and raw workspace/channel ids — on a project-visible session.
    const prompts: string[] = [];
    const h = harness({
      row: row({ opencode_model: 'kortix/glm-5.3-flash', title_source: 'bump the node version in CI' }),
      generate: async (_model, _auth, promptText) => {
        prompts.push(promptText);
        return 'Bump Node In CI';
      },
    });
    await generateSessionTitleFromFirstPrompt(
      { ...input, firstPromptText: "You're answering on Slack.\nWorkspace: T0123\nMessage:\nhi" },
      h.options,
    );
    expect(prompts).toEqual(['bump the node version in CI']);
    expect(h.persisted).toEqual(['Bump Node In CI']);
  });

  it('treats a NON-STRING name/custom_name as set — the CAS reads it as text', async () => {
    // `metadata->>'name'` stringifies any jsonb scalar, so a row the TS gate
    // waved through would fail the UPDATE silently and re-bill on every prompt.
    const numericName = harness({
      row: row({ name: 123, opencode_model: 'kortix/glm-5.3-flash' }),
    });
    await generateSessionTitleFromFirstPrompt(input, numericName.options);
    expect(numericName.persisted).toEqual([]);
    expect(numericName.generateCalls()).toBe(0);

    const numericCustom = harness({
      row: row({ custom_name: 123, opencode_model: 'kortix/glm-5.3-flash' }),
    });
    await generateSessionTitleFromFirstPrompt(input, numericCustom.options);
    expect(numericCustom.persisted).toEqual([]);
    expect(numericCustom.generateCalls()).toBe(0);
  });

  it('collapses concurrent same-session calls to one gateway call and one minted key', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      generate: async () => {
        await gate;
        return 'Set Up MS Graph';
      },
    });

    const first = generateSessionTitleFromFirstPrompt(
      { ...input, sessionId: 'dedupe-1' },
      h.options,
    );
    const second = generateSessionTitleFromFirstPrompt(
      { ...input, sessionId: 'dedupe-1' },
      h.options,
    );
    release();
    await Promise.all([first, second]);

    expect(h.minted).toEqual(['k']);
    expect(h.persisted).toEqual(['Set Up MS Graph']);

    // A genuine retry AFTER the first settles is admitted again.
    await generateSessionTitleFromFirstPrompt({ ...input, sessionId: 'dedupe-1' }, h.options);
    expect(h.persisted).toEqual(['Set Up MS Graph', 'Set Up MS Graph']);
  });

  it('revokes the minted key even when generation throws', async () => {
    const h = harness({
      generate: async () => {
        throw new Error('gateway down');
      },
    });
    await generateSessionTitleFromFirstPrompt(input, h.options);
    expect(h.persisted).toEqual(['Please set up the MS Graph OAuth2 connector']);
    expect(h.revoked).toEqual(['key-1']);
  });

  it('does not persist an empty prompt', async () => {
    const h = harness();
    await generateSessionTitleFromFirstPrompt({ ...input, firstPromptText: '   ' }, h.options);
    expect(h.persisted).toEqual([]);
  });

  // ── Native mode (project `llm_gateway` flag OFF) ─────────────────────────
  it('native mode runs NO gateway pipeline — no mint, no generate — and titles from the prompt', async () => {
    const h = harness({ resolveLlmGatewayEnabled: async () => false });
    await generateSessionTitleFromFirstPrompt(
      { ...input, modelHint: 'anthropic/claude-sonnet-4-6' },
      h.options,
    );
    expect(h.minted).toEqual([]);
    expect(h.generateCalls()).toBe(0);
    expect(h.persisted).toEqual(['Please set up the MS Graph OAuth2 connector']);
  });
});
