/**
 * Dev-only: rewrites loopback URLs (`127.0.0.1`, `localhost`) on every
 * `XMLHttpRequest.open` to the host the device can reach.
 *
 * Why: against the local stack, the API signs attachment uploads with its own
 * `SUPABASE_URL` (`http://127.0.0.1:54321/...`). The SDK PUTs the file to that
 * URL. On a phone, `127.0.0.1` is the phone itself, so every upload failed.
 * The app's own base URLs are already remapped by `resolveLocalUrl`; URLs the
 * server hands back are not. Pure (the class and the rewrite are injected), so
 * `bun test` can run it.
 */

const INSTALLED = Symbol.for('kortix.loopbackRewrite');

type OpenableClass = { prototype: { open: (method: string, url: string, ...rest: unknown[]) => void } };

export function installLoopbackRewrite(Xhr: OpenableClass, rewrite: (url: string) => string): void {
  const proto = Xhr.prototype as OpenableClass['prototype'] & { [INSTALLED]?: true };
  if (proto[INSTALLED]) return;
  const open = proto.open;
  proto.open = function (this: unknown, method: string, url: string, ...rest: unknown[]) {
    return open.call(this, method, typeof url === 'string' ? rewrite(url) : url, ...rest);
  };
  proto[INSTALLED] = true;
}
