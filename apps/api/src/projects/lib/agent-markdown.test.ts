import { describe, expect, test } from 'bun:test';
import { frontmatterParseError, parseAgentMarkdown, serializeAgentMarkdown } from './agent-markdown';

describe('parseAgentMarkdown', () => {
  test('body-only file with no fence parses to empty frontmatter', () => {
    const result = parseAgentMarkdown('You are the Kortix agent.');
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe('You are the Kortix agent.');
  });

  test('fenced frontmatter parses to fields + body', () => {
    const result = parseAgentMarkdown(
      '---\nmode: primary\nmodel: anthropic/claude-sonnet-5\n---\n\nSystem prompt body.',
    );
    expect(result.frontmatter).toEqual({
      mode: 'primary',
      model: 'anthropic/claude-sonnet-5',
    });
    expect(result.body).toBe('System prompt body.');
  });

  test('nested permission tree, numbers, and booleans survive', () => {
    const result = parseAgentMarkdown(
      '---\ntemperature: 0.2\nhidden: false\npermission:\n  bash:\n    "git push": deny\n    "*": allow\n---\nbody',
    );
    expect(result.frontmatter.temperature).toBe(0.2);
    expect(result.frontmatter.hidden).toBe(false);
    expect(result.frontmatter.permission).toEqual({
      bash: { 'git push': 'deny', '*': 'allow' },
    });
  });

  test('CRLF line endings are handled', () => {
    const result = parseAgentMarkdown('---\r\nmode: subagent\r\n---\r\nbody');
    expect(result.frontmatter).toEqual({ mode: 'subagent' });
    expect(result.body).toBe('body');
  });

  test('malformed frontmatter degrades to body-only rather than throwing', () => {
    const result = parseAgentMarkdown('---\n: : : not yaml\n---\nbody');
    expect(result.frontmatter).toEqual({});
  });

  test('non-mapping frontmatter (a list) degrades to empty', () => {
    const result = parseAgentMarkdown('---\n- one\n- two\n---\nbody');
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe('body');
  });
});

describe('serializeAgentMarkdown', () => {
  test('empty frontmatter yields a body-only file (no fence)', () => {
    expect(serializeAgentMarkdown({}, 'just a body')).toBe('just a body');
  });

  test('undefined values are omitted, and an all-undefined map stays body-only', () => {
    expect(serializeAgentMarkdown({ mode: undefined }, 'body')).toBe('body');
  });

  test('fields are written as a fenced block', () => {
    const out = serializeAgentMarkdown({ mode: 'primary' }, 'body');
    expect(out).toBe('---\nmode: primary\n---\n\nbody');
  });
});

describe('frontmatterParseError', () => {
  test('body-only file with no fence has no error', () => {
    expect(frontmatterParseError('You are the Kortix agent.')).toBeNull();
  });

  test('valid fenced frontmatter has no error', () => {
    expect(frontmatterParseError('---\nmode: primary\n---\n\nbody')).toBeNull();
  });

  test('malformed frontmatter that parseAgentMarkdown silently swallows is surfaced here', () => {
    const content = '---\n: : : not yaml\n---\nbody';
    // parseAgentMarkdown degrades this to an empty frontmatter object...
    expect(parseAgentMarkdown(content).frontmatter).toEqual({});
    // ...but frontmatterParseError surfaces the underlying YAML error instead.
    expect(frontmatterParseError(content)).not.toBeNull();
  });
});

describe('round-trip', () => {
  test('parse then serialize preserves frontmatter and body', () => {
    const original =
      '---\nmode: primary\npermission:\n  bash: allow\n---\n\nThe prompt.';
    const { frontmatter, body } = parseAgentMarkdown(original);
    const round = serializeAgentMarkdown(frontmatter, body);
    expect(parseAgentMarkdown(round).frontmatter).toEqual(frontmatter);
    expect(parseAgentMarkdown(round).body).toBe(body);
  });
});
