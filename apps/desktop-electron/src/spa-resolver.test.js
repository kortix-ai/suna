// Tests for the bundle path resolver.
//
// This module decides which file every request in the packaged app receives, so
// its failure modes are the app's failure modes: a bad shell match renders the
// wrong project, a missed RSC payload breaks client navigation, and a path that
// escapes the export root is a file-disclosure bug in a shipped binary.

const { describe, it, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveSpaFile, SHELL_SEGMENT } = require('./spa-resolver');

/** Build a throwaway export tree shaped like a real `next build` output. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kortix-bundle-'));
  const write = (rel) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rel);
  };

  write('projects.html');
  write('auth.html');
  write(path.join('auth', 'callback.html'));
  write(path.join('projects', `${SHELL_SEGMENT}.html`));
  write(path.join('projects', SHELL_SEGMENT, 'files.html'));
  write(path.join('projects', SHELL_SEGMENT, 'sessions', `${SHELL_SEGMENT}.html`));
  // Next names client-navigation payloads after the route PATTERN, not the
  // param values — which is why a segment rewrite reaches them at all.
  write(
    path.join(
      'projects',
      SHELL_SEGMENT,
      'sessions',
      SHELL_SEGMENT,
      '__next.projects.$d$id.sessions.$d$sessionId.__PAGE__.txt',
    ),
  );
  write(path.join('projects', 'start.html'));
  write(path.join('_next', 'static', 'chunk.js'));
  return root;
}

describe('resolveSpaFile', () => {
  const root = fixture();
  const rel = (pathname) => {
    const file = resolveSpaFile(root, pathname);
    return file === null ? null : path.relative(root, file);
  };

  it('serves a static route', () => {
    expect(rel('/projects')).toBe('projects.html');
    expect(rel('/auth')).toBe('auth.html');
    expect(rel('/auth/callback')).toBe(path.join('auth', 'callback.html'));
  });

  it('serves the shell for a real project id', () => {
    expect(rel('/projects/proj_abc123')).toBe(path.join('projects', `${SHELL_SEGMENT}.html`));
  });

  it('serves the shell for nested dynamic segments', () => {
    expect(rel('/projects/proj_abc/sessions/sess_xyz')).toBe(
      path.join('projects', SHELL_SEGMENT, 'sessions', `${SHELL_SEGMENT}.html`),
    );
    expect(rel('/projects/proj_abc/files')).toBe(
      path.join('projects', SHELL_SEGMENT, 'files.html'),
    );
  });

  it('resolves RSC payloads under a rewritten dynamic path', () => {
    // The regression this guards: client-side navigation 404s while the initial
    // deep link works, because only the HTML was rewritten.
    expect(
      rel(
        '/projects/proj_abc/sessions/sess_xyz/__next.projects.$d$id.sessions.$d$sessionId.__PAGE__.txt',
      ),
    ).toBe(
      path.join(
        'projects',
        SHELL_SEGMENT,
        'sessions',
        SHELL_SEGMENT,
        '__next.projects.$d$id.sessions.$d$sessionId.__PAGE__.txt',
      ),
    );
  });

  it('lets an exact route beat the shell', () => {
    // `/projects/start` is a real page. When the shell shadowed it, the app
    // rendered a project view for the new-project door.
    expect(rel('/projects/start')).toBe(path.join('projects', 'start.html'));
  });

  it('serves hashed assets untouched', () => {
    expect(rel('/_next/static/chunk.js')).toBe(path.join('_next', 'static', 'chunk.js'));
  });

  it('decodes percent-encoded ids', () => {
    expect(rel('/projects/proj%20with%20space')).toBe(
      path.join('projects', `${SHELL_SEGMENT}.html`),
    );
  });

  it('returns null for a path the bundle does not carry', () => {
    // The loopback server turns this into a redirect to the real website.
    expect(rel('/legal/terms')).toBe(null);
    expect(rel('/nope/nothing/here')).toBe(null);
  });

  it('refuses to escape the export root', () => {
    // A shipped binary serving arbitrary files off the user's disk is the worst
    // outcome this module can produce.
    const secret = path.join(path.dirname(root), 'outside-the-root.txt');
    fs.writeFileSync(secret, 'should never be served');
    try {
      expect(rel('/../outside-the-root.txt')).toBe(null);
      expect(rel('/projects/../../outside-the-root.txt')).toBe(null);
      expect(rel('/_next/../../outside-the-root.txt')).toBe(null);
    } finally {
      fs.rmSync(secret, { force: true });
    }
  });
});
