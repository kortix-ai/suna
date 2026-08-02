import { describe, expect, it } from 'bun:test';

import {
  PLACEHOLDER_TITLE_SQL_PATTERN,
  isPlaceholderOpencodeTitle,
} from '../projects/lib/opencode-title';
import type { ProjectSessionRow } from '../projects/lib/serializers';
import {
  type GenerateSessionTitleOptions,
  buildSessionTitleRequestBody,
  extractPromptInfo,
  generateSessionTitleFromFirstPrompt,
  sanitizeGeneratedTitle,
  titleSourceForCreate,
} from '../projects/session-title-generate';

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

describe('sanitizeGeneratedTitle', () => {
  it('strips wrapping quotes and collapses whitespace', () => {
    expect(sanitizeGeneratedTitle('  "Set Up  MS Graph"  ')).toBe('Set Up MS Graph');
    expect(sanitizeGeneratedTitle('`Fix the login bug`')).toBe('Fix the login bug');
  });

  it('caps length and drops newlines', () => {
    const long = 'a'.repeat(200);
    const out = sanitizeGeneratedTitle('line one\nline two');
    expect(out).toBe('line one line two');
    expect((sanitizeGeneratedTitle(long) ?? '').length).toBeLessThanOrEqual(64);
  });

  it('rejects empty and placeholder-shaped titles', () => {
    expect(sanitizeGeneratedTitle('')).toBeNull();
    expect(sanitizeGeneratedTitle('   ')).toBeNull();
    expect(sanitizeGeneratedTitle(null)).toBeNull();
    expect(sanitizeGeneratedTitle('New session - 2026-07-28')).toBeNull();
    expect(sanitizeGeneratedTitle('New agent')).toBeNull();
  });
});

describe('buildSessionTitleRequestBody', () => {
  it('reserves enough output tokens for reasoning-capable fallback models', () => {
    const body = buildSessionTitleRequestBody(
      'glm-5.2',
      'Please set up the MS Graph OAuth2 connector',
    );

    expect(body.max_tokens).toBeGreaterThanOrEqual(256);
    expect(body.stream).toBe(false);
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
    expect(extractPromptInfo(bodyOf({ model: 'kortix/glm-5.2' }), headers()).model).toBe('glm-5.2');
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

describe('PLACEHOLDER_TITLE_SQL_PATTERN', () => {
  // JS translation of the POSIX classes so the SQL predicate and the TS one
  // cannot drift: `[:alnum:]` is `[0-9A-Za-z]`, and the pattern's `_` makes the
  // class the exact complement of JavaScript's `\w`.
  const asJs = new RegExp(PLACEHOLDER_TITLE_SQL_PATTERN.replace('[:alnum:]_', '0-9A-Za-z_'), 'i');

  it('is a POSIX twin of isPlaceholderOpencodeTitle', () => {
    const fixtures = [
      'New session',
      'New session - Jul 29',
      'new SESSION x',
      'New session_x',
      'NEW SESSION',
      '  New session - 2026-07-28  ',
      'New sessions of work',
      'Newsession',
      'New session planning doc',
      'New agent',
      'NEW AGENT',
      'New agent - Aug 3',
      'New agents at work',
      'New agent planning doc',
      'Set Up MS Graph',
      '',
    ];
    for (const fixture of fixtures) {
      expect([fixture, asJs.test(fixture.trim())]).toEqual([
        fixture,
        isPlaceholderOpencodeTitle(fixture),
      ]);
    }
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
  });

  it('falls back to opencode_model when the prompt carries no model', async () => {
    const h = harness({ row: row({ opencode_model: 'kortix/glm-5.2' }) });
    await generateSessionTitleFromFirstPrompt(input, h.options);
    expect(h.models).toEqual(['glm-5.2']);
  });

  it('generates, sanitizes, and persists a title; always revokes the key', async () => {
    const h = harness();
    await generateSessionTitleFromFirstPrompt(
      { ...input, modelHint: 'codex/gpt-5.6-sol' },
      h.options,
    );
    expect(h.persisted).toEqual(['Set Up MS Graph']);
    expect(h.revoked).toEqual(['key-1']);
  });

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

    const veyrisPlaceholder = harness({
      row: row({ name: 'New agent', opencode_model: 'codex/gpt-5.6-sol' }),
    });
    await generateSessionTitleFromFirstPrompt(input, veyrisPlaceholder.options);
    expect(veyrisPlaceholder.persisted).toEqual(['Set Up MS Graph']);
  });

  it('falls back to a resolved SERVABLE model when neither the turn nor the row names one', async () => {
    // Create-time and every server-side delivery arrive with no modelHint, and
    // `opencode_model` is absent whenever session create resolved no default —
    // without this fallback those sessions would stay untitled forever.
    const h = harness({ row: row({}), fallbackModel: async () => 'glm-5.2' });
    await generateSessionTitleFromFirstPrompt(input, h.options);
    expect(h.models).toEqual(['glm-5.2']);
    expect(h.persisted).toEqual(['Set Up MS Graph']);
  });

  it('spends NOTHING when no model is servable — free tier, or no managed provider', async () => {
    // The unconditional platform default is a managed id: on a free tier (or a
    // deployment with no managed provider) the gateway refuses it, so minting a
    // key and calling would be a doomed, billed, untitled loop on every prompt.
    const h = harness({ row: row({}), fallbackModel: async () => null });
    await generateSessionTitleFromFirstPrompt(input, h.options);
    expect(h.models).toEqual([]);
    expect(h.minted).toEqual([]);
    expect(h.persisted).toEqual([]);
  });

  it('precedence: modelHint beats opencode_model beats the resolved fallback', async () => {
    const hint = harness({ row: row({ opencode_model: 'kortix/glm-5.2' }) });
    await generateSessionTitleFromFirstPrompt(
      { ...input, modelHint: 'codex/gpt-5.6-sol' },
      hint.options,
    );
    expect(hint.models).toEqual(['codex/gpt-5.6-sol']);

    const stored = harness({
      row: row({ opencode_model: 'kortix/glm-5.2' }),
      fallbackModel: async () => 'never/used',
    });
    await generateSessionTitleFromFirstPrompt(input, stored.options);
    expect(stored.models).toEqual(['glm-5.2']);

    const fallback = harness({ row: row({}), fallbackModel: async () => 'anthropic/claude' });
    await generateSessionTitleFromFirstPrompt(input, fallback.options);
    expect(fallback.models).toEqual(['anthropic/claude']);
  });

  it('titles from the create-time title_source, never the rendered envelope it was handed', async () => {
    // A Slack/Teams/Telegram session bakes a rendered envelope as its prompt; a
    // later fallback hook only ever sees THAT text. Without the stored source, a
    // transient create-hook failure names the session after turn instructions
    // and raw workspace/channel ids — on a project-visible session.
    const prompts: string[] = [];
    const h = harness({
      row: row({ opencode_model: 'kortix/glm-5.2', title_source: 'bump the node version in CI' }),
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
      row: row({ name: 123, opencode_model: 'kortix/glm-5.2' }),
    });
    await generateSessionTitleFromFirstPrompt(input, numericName.options);
    expect(numericName.persisted).toEqual([]);
    expect(numericName.generateCalls()).toBe(0);

    const numericCustom = harness({
      row: row({ custom_name: 123, opencode_model: 'kortix/glm-5.2' }),
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
    expect(h.persisted).toEqual([]);
    expect(h.revoked).toEqual(['key-1']);
  });

  it('does not persist an empty prompt', async () => {
    const h = harness();
    await generateSessionTitleFromFirstPrompt({ ...input, firstPromptText: '   ' }, h.options);
    expect(h.persisted).toEqual([]);
  });
});
