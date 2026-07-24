import { describe, expect, it } from 'bun:test';
import { resolveOpenablePath } from './clickable-path';

// ─── Agents write workspace-relative paths far more often than absolute ones.
// This component used to reject anything without a leading slash, so clicking
// `docs/bio.md` in chat produced "Cannot open relative path" for a file that
// exists. Resolution — not rejection — is what the rest of the app does with
// these same strings. ───────────────────────────────────────────────────────

describe('resolveOpenablePath', () => {
  it('anchors a workspace-relative path under /workspace', () => {
    expect(resolveOpenablePath('docs/jay-suthar-bio.md')).toBe('/workspace/docs/jay-suthar-bio.md');
  });

  it('anchors a bare filename', () => {
    expect(resolveOpenablePath('README.md')).toBe('/workspace/README.md');
  });

  it('passes an already-absolute workspace path through unchanged', () => {
    expect(resolveOpenablePath('/workspace/src/index.ts')).toBe('/workspace/src/index.ts');
  });

  it('leaves the other allowed sandbox roots alone', () => {
    expect(resolveOpenablePath('/tmp/out.log')).toBe('/tmp/out.log');
    expect(resolveOpenablePath('/home/user/.bashrc')).toBe('/home/user/.bashrc');
  });

  it('tolerates surrounding whitespace from a text scan', () => {
    expect(resolveOpenablePath('  docs/bio.md  ')).toBe('/workspace/docs/bio.md');
  });

  it('returns null for an empty or whitespace-only path rather than /workspace', () => {
    expect(resolveOpenablePath('')).toBeNull();
    expect(resolveOpenablePath('   ')).toBeNull();
  });
});
