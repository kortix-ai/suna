import { fileURLToPath } from 'node:url';

const entrypoint = fileURLToPath(new URL('./annotation-bridge.ts', import.meta.url));

async function compileBridge(): Promise<string> {
  const build = await Bun.build({ entrypoints: [entrypoint], target: 'browser', format: 'iife', minify: true });
  if (!build.success || build.outputs.length !== 1) throw new Error('Artifact annotation bridge build failed');
  const source = await build.outputs[0]!.text();
  if (!source.trim()) throw new Error('Artifact annotation bridge is empty');
  return source;
}

export function createArtifactAnnotationInjector(build: () => Promise<string> = compileBridge) {
  let compiled: Promise<string> | undefined;
  return async (response: Response): Promise<Response> => {
    const source = await (compiled ??= build());
    const headers = new Headers(response.headers);
    for (const name of ['Content-Length', 'Content-Range', 'ETag', 'Last-Modified', 'Accept-Ranges']) headers.delete(name);
    headers.set('Cache-Control', 'private, no-store');
    const script = source.replace(/<\/script/gi, (tag) => tag.replace('</', '<\\/'));
    return new HTMLRewriter().onDocument({
      end(document) { document.append(`<script id="kortix-annotate.js">${script}</script>`, { html: true }); },
    }).transform(new Response(response.body, { status: 200, headers }));
  };
}

export const injectArtifactAnnotations = createArtifactAnnotationInjector();
