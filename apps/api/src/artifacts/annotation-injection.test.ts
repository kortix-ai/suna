import { expect, spyOn, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { createArtifactAnnotationInjector } from './annotation-injection';

const script = 'globalThis.annotationBridgeReady=true;';
const csp = 'sandbox allow-scripts allow-forms allow-popups';

test('annotation injection parses fragments and appends one constant script after page-owned content', async () => {
  const inject = createArtifactAnnotationInjector(async () => script);
  for (const html of ['<p>Fragment</p>', '<!doctype html><html><body><p data-close="</body>">Page</p></body></html>']) {
    const response = await inject(new Response(html, { headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': csp } }));
    const rendered = await response.text();
    expect(rendered.startsWith(html)).toBe(true);
    expect(rendered.match(/id="kortix-annotate\.js"/g)).toHaveLength(1);
    expect(rendered.endsWith(`<script id="kortix-annotate.js">${script}</script>`)).toBe(true);
    expect(response.headers.get('Content-Security-Policy')).toBe(csp);
  }
});

test('annotation rewrites invalidate source validators and partial-content metadata', async () => {
  const inject = createArtifactAnnotationInjector(async () => script);
  const response = await inject(new Response('<p>Full page</p>', { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp,
    'Cache-Control': 'private, max-age=3600', 'Content-Length': '16', 'Content-Range': 'bytes 0-15/16',
    ETag: '"original"', 'Last-Modified': 'Thu, 29 Oct 2026 00:00:00 GMT', 'Accept-Ranges': 'bytes',
  } }));
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  for (const name of ['Content-Length', 'Content-Range', 'ETag', 'Last-Modified', 'Accept-Ranges']) expect(response.headers.has(name)).toBe(false);
  expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
  expect(response.headers.get('Content-Security-Policy')).toBe(csp);
});

test('concurrent annotation requests share one immutable compiled script', async () => {
  let builds = 0;
  const inject = createArtifactAnnotationInjector(async () => { builds++; await Promise.resolve(); return script; });
  const bodies = await Promise.all(Array.from({ length: 4 }, (_, i) => inject(new Response(`<p>${i}</p>`)).then(r => r.text())));
  expect(builds).toBe(1);
  expect(bodies.every(body => body.includes(script))).toBe(true);
});

test('a failed compile stays failed without returning unannotated HTML or recompiling each request', async () => {
  let builds = 0;
  const inject = createArtifactAnnotationInjector(async () => { builds++; throw new Error('build unavailable'); });
  await expect(inject(new Response('<p>One</p>'))).rejects.toThrow('build unavailable');
  await expect(inject(new Response('<p>Two</p>'))).rejects.toThrow('build unavailable');
  expect(builds).toBe(1);
});

test('compiled string literals cannot close the trusted script element', async () => {
  const inject = createArtifactAnnotationInjector(async () => 'globalThis.label="</ScRiPt><script>page()";');
  const html = await (await inject(new Response('<p>Page</p>'))).text();
  expect(html).toContain('globalThis.label="<\\/ScRiPt><script>page()";');
  expect(html.match(/<\/script>/g)).toHaveLength(1);
});

test('production compilation accepts only the fixed trusted browser IIFE entry', async () => {
  const build = spyOn(Bun, 'build').mockResolvedValue({ success: true, outputs: [new Blob([script])], logs: [] } as unknown as Awaited<ReturnType<typeof Bun.build>>);
  try {
    const inject = createArtifactAnnotationInjector();
    await Promise.all([inject(new Response('<p>One</p>')), inject(new Response('<p>Two</p>'))]);
    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledWith({
      entrypoints: [fileURLToPath(new URL('./annotation-bridge.ts', import.meta.url))], target: 'browser', format: 'iife', minify: true,
    });
  } finally { build.mockRestore(); }
});

test('failed, empty, or split builds never produce a partially trusted script', async () => {
  const build = spyOn(Bun, 'build');
  try {
    for (const result of [
      { success: false, outputs: [], logs: [] },
      { success: true, outputs: [new Blob([''])], logs: [] },
      { success: true, outputs: [new Blob([script]), new Blob([script])], logs: [] },
    ]) {
      build.mockResolvedValue(result as unknown as Awaited<ReturnType<typeof Bun.build>>);
      await expect(createArtifactAnnotationInjector()(new Response('<p>Page</p>'))).rejects.toThrow();
    }
  } finally { build.mockRestore(); }
});
