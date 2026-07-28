import { describe, expect, it } from 'bun:test';

import type { ProjectSessionRow } from '../projects/lib/serializers';
import {
  type GenerateSessionTitleOptions,
  extractPromptInfo,
  generateSessionTitleFromFirstPrompt,
  sanitizeGeneratedTitle,
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

  it('reads ACP { params: { prompt, model } }', () => {
    const body = bodyOf({
      method: 'session/prompt',
      params: {
        sessionId: 'x',
        prompt: [{ type: 'text', text: 'set up connector' }],
        model: { providerID: 'kortix', modelID: 'glm-5.2' },
      },
    });
    expect(extractPromptInfo(body, headers())).toEqual({
      text: 'set up connector',
      model: 'glm-5.2',
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

  it('skips a user-named session (custom_name) but re-titles a placeholder name', async () => {
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
  });

  it('skips when the session has no model to title with', async () => {
    const h = harness({ row: row({}) });
    await generateSessionTitleFromFirstPrompt(input, h.options);
    expect(h.persisted).toEqual([]);
    expect(h.generateCalls()).toBe(0);
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
