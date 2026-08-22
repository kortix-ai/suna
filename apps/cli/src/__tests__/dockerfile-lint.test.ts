import { describe, expect, test } from 'bun:test';

import { PLATFORM_DEFAULT_USER_DOCKERFILE } from '@kortix/shared/sandbox';

import { lintDockerfile } from '../dockerfile-lint.ts';

const lint = (text: string) => lintDockerfile(text, { path: 'Dockerfile' });

describe('lintDockerfile — COPY/ADD from the build context', () => {
  test('a COPY of a repo file is an error naming the file (the real incident)', () => {
    // Verbatim from the incident: the cloud build died with
    // "Path does not exist: /tmp/kortix-snap-XXXX/requirements-kortix.txt".
    const issues = lint('FROM ubuntu:24.04\nCOPY requirements-kortix.txt .\n');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.line).toBe(2);
    expect(issues[0]!.path).toBe('Dockerfile');
    expect(issues[0]!.message).toContain('requirements-kortix.txt');
    // It must say WHY, not just "no".
    expect(issues[0]!.message).toContain('/workspace');
  });

  test('COPY --from=<stage> is clean — a multi-stage copy reads an image, not the context', () => {
    expect(
      lint('FROM golang:1.22 AS builder\nFROM ubuntu:24.04\nCOPY --from=builder /app /app\n'),
    ).toEqual([]);
  });

  test('ADD of a remote URL is clean — Docker fetches it over the network', () => {
    expect(lint('FROM ubuntu:24.04\nADD https://example.com/data.tar.gz /opt/data.tar.gz\n')).toEqual(
      [],
    );
  });

  test('ADD of a repo file is still an error', () => {
    const issues = lint('FROM ubuntu:24.04\nADD ./seed.sql /opt/seed.sql\n');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.message).toContain('seed.sql');
  });

  test('flags every source of a multi-source COPY, and survives continuations', () => {
    const issues = lint('FROM ubuntu:24.04\nCOPY a.txt \\\n     b.txt \\\n     /opt/\n');
    expect(issues.map((i) => i.severity)).toEqual(['error', 'error']);
    expect(issues[0]!.message).toContain('a.txt');
    expect(issues[1]!.message).toContain('b.txt');
    // Both belong to the instruction that STARTS on line 2.
    expect(issues.map((i) => i.line)).toEqual([2, 2]);
  });
});

describe('lintDockerfile — RUN heredocs', () => {
  test('a RUN heredoc is an error (buildah parses its body as instructions)', () => {
    const issues = lint(
      ['FROM ubuntu:24.04', "RUN python3 <<'PY'", 'import importlib', 'print("ok")', 'PY', ''].join(
        '\n',
      ),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.line).toBe(2);
    expect(issues[0]!.message).toContain('heredoc');
    expect(issues[0]!.message).toContain('Platinum');
  });

  test("the heredoc BODY isn't parsed as instructions (no phantom COPY error)", () => {
    const issues = lint(
      ['FROM ubuntu:24.04', 'RUN cat <<EOF', 'COPY not-a-real-instruction here', 'EOF', ''].join('\n'),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('heredoc');
  });

  test('a `python3 -c` one-liner — the portable equivalent — is clean', () => {
    expect(lint(`FROM ubuntu:24.04\nRUN python3 -c 'import sys; print(sys.version)'\n`)).toEqual([]);
  });
});

describe('lintDockerfile — non-Debian base', () => {
  test('FROM alpine:3 warns (not errors — the tag could be a Debian derivative)', () => {
    const issues = lint('FROM alpine:3\nRUN echo hi\n');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.line).toBe(1);
    expect(issues[0]!.message).toContain('apt-get');
  });

  test('the family in the TAG is caught too (node:20-alpine)', () => {
    const issues = lint('FROM node:20-alpine\n');
    expect(issues.map((i) => i.severity)).toEqual(['warning']);
  });

  test('an alpine BUILDER stage is fine when the final base is Debian', () => {
    // The Kortix layer is appended to the END, so only the last stage's base
    // has to carry apt.
    expect(lint('FROM alpine:3 AS builder\nRUN echo build\n\nFROM ubuntu:24.04\n')).toEqual([]);
  });

  test('Debian-family bases are clean', () => {
    for (const base of ['ubuntu:24.04', 'debian:bookworm-slim', 'python:3.12-slim', 'node:20']) {
      expect(lint(`FROM ${base}\n`)).toEqual([]);
    }
  });

  test('an unresolvable ARG base is not guessed at', () => {
    expect(lint('ARG BASE_IMAGE=ubuntu:24.04\nFROM ${BASE_IMAGE}\n')).toEqual([]);
  });
});

describe('lintDockerfile — the platform default text', () => {
  test('the Dockerfile Kortix itself ships is clean', () => {
    // If our own default tripped these checks, the checks would be wrong.
    expect(lint(PLATFORM_DEFAULT_USER_DOCKERFILE)).toEqual([]);
  });

  test('comments are never linted', () => {
    expect(lint('FROM ubuntu:24.04\n# COPY secrets.txt /etc\n# RUN sh <<EOF\n')).toEqual([]);
  });
});
