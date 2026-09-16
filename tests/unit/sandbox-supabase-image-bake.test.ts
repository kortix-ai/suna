import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const devLocal = readFileSync(resolve(root, 'scripts/dev-local.sh'), 'utf8');

/**
 * A sandbox image may bake the Supabase service images as Docker-loadable
 * tarballs under `/opt/sb-images` (crane keeps the registry's gzipped blobs, so
 * the full nine-image set is ~2 GB on disk — verified with `crane manifest`,
 * and re-gzipping a pulled tarball saves nothing).
 *
 * That bake only pays for itself if `run_sandbox_dev` LOADS it. Between
 * 2026-06-07 and 2026-09-16 it did not: the loader was written
 * (`663ca9513c "fix(dev): load baked supabase images in sandboxes"`) and never
 * merged to main, so one project's image carried ~2 GB it never read while
 * `supabase start` pulled the same bytes over the network on every boot. The
 * image reached 10.04 GB against Daytona's 10 GB snapshot ceiling and no
 * Daytona session on that project could start.
 *
 * These pin the two halves that must stay in step. They are source-text
 * assertions because the behaviour lives in a shell script the test suite never
 * executes — the same convention as `ecs-deploy-environment.test.ts`.
 */
describe('run_sandbox_dev: the baked Supabase images are loaded, not just carried', () => {
  it('loads every baked tarball before starting Supabase', () => {
    const loadAt = devLocal.indexOf('/opt/sb-images');
    const startAt = devLocal.indexOf('supabase start -x');
    expect(loadAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(-1);
    // Loading after `supabase start` would be useless — it pulls what is missing.
    expect(loadAt).toBeLessThan(startAt);
    expect(devLocal).toContain('docker load -i');
  });

  it('is inert in an image that bakes nothing', () => {
    // Every other sandbox image has no /opt/sb-images, and must not be affected.
    expect(devLocal).toContain('if [[ -d /opt/sb-images ]]');
  });

  it('never lets a failed load abort the boot', () => {
    // `supabase start` can always fall back to pulling; a corrupt tarball must
    // degrade to slow, not to a dead session.
    const loader = devLocal.slice(
      devLocal.indexOf('if [[ -d /opt/sb-images ]]'),
      devLocal.indexOf('supabase start -x'),
    );
    expect(loader).toMatch(/\|\|\s*echo/);
  });

  it('excludes exactly the services an agent-driven stack never runs', () => {
    // `studio` is the web dashboard, `imgproxy` serves storage image transforms.
    // Excluding them is what lets the sandbox image stop baking them (376 MB:
    // studio 314 MB + imgproxy 62 MB, measured via `crane manifest`
    // linux/amd64). If this list changes, the image's fetch_image list in
    // kortix-ai/company `.kortix/Dockerfile.dev` must change with it.
    expect(devLocal).toContain('supabase start -x studio,imgproxy');
  });

  it('keeps the services the API and auth flows actually depend on', () => {
    // A regression here would silently remove Postgres, auth, REST, storage or
    // the mail catcher the signup flows read.
    const excluded = devLocal.match(/supabase start -x ([a-z0-9,-]+)/)?.[1] ?? '';
    for (const required of ['postgres', 'gotrue', 'postgrest', 'storage-api', 'kong', 'mailpit']) {
      expect(excluded.split(',')).not.toContain(required);
    }
  });
});
