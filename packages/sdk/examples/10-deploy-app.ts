/**
 * 10 — Deploy a public OCI image as a serverless Kortix App.
 *
 * Run:
 *   KORTIX_API_URL=https://api.kortix.com/v1 KORTIX_API_KEY=kortix_pat_... \
 *   KORTIX_PROJECT_ID=... bun run examples/10-deploy-app.ts
 *
 * As an npm consumer:
 *   import { createKortix } from '@kortix/sdk';
 */
import { createKortix } from '../src/index';

async function main() {
  const backendUrl = process.env.KORTIX_API_URL ?? 'http://localhost:8008/v1';
  const apiKey = process.env.KORTIX_API_KEY;
  const workspaceId = process.env.KORTIX_PROJECT_ID;
  if (!apiKey || !workspaceId) {
    console.error('Set KORTIX_API_KEY and KORTIX_PROJECT_ID and re-run.');
    process.exit(1);
  }

  const kortix = createKortix({ backendUrl, getToken: async () => apiKey });
  const apps = kortix.project(workspaceId).apps;
  const app = await apps.create({ slug: 'hello', name: 'Hello App' });
  const registered = await apps.artifacts.register({
    kind: 'oci_image',
    image: 'docker.io/hashicorp/http-echo:1.0',
  });
  const deployment = await apps.deployments.create(app.app_id, {
    artifact_id: registered.artifact.artifact_id,
    source: {
      kind: 'oci_image',
      image: 'docker.io/hashicorp/http-echo:1.0',
      command: ['http-echo', '-listen=:5678', '-text=Hello from Kortix Apps'],
      port: 5678,
    },
  });

  console.log(`${deployment.status}: ${app.url}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
