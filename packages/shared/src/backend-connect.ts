/**
 * How to reach a Kortix backend: the snippets the web Connect dialog shows and
 * `kortix backends connect <name>` prints. One source, so both stay the same.
 *
 * Pure and secret-free. The admin key never goes in: the web reveals it on an
 * explicit click and the CLI prints it with `kortix backends env`, both through
 * the audited credentials route.
 */

export type BackendConnectTab = 'app' | 'outside' | 'admin';

/** Stable ids. Hosts title each snippet by its id; the CLI uses `title`. */
export type BackendConnectSnippetId =
  | 'app-install'
  | 'app-backends'
  | 'app-env'
  | 'app-client'
  | 'backend-auth-config'
  | 'backend-function'
  | 'outside-token-cli'
  | 'outside-token-sdk'
  | 'outside-query'
  | 'outside-mutation'
  | 'outside-http-action'
  | 'outside-verify'
  | 'outside-verify-env'
  | 'admin-cli';

export interface BackendConnectSnippet {
  id: BackendConnectSnippetId;
  tab: BackendConnectTab;
  /** English title. */
  title: string;
  /** Where the code goes: a file path, or `terminal`. */
  file: string;
  language: 'ts' | 'sh' | 'dotenv';
  code: string;
}

/** The fields of a backend the snippets need (a subset of the API's Backend object). */
export interface BackendConnectTarget {
  backend_id: string;
  project_id: string;
  name: string;
  url: string | null;
  site_url: string | null;
  /** Public values that verify the backend's member tokens. Absent on older APIs and pre-sign-in backends. */
  auth_env?: Record<string, string> | null;
}

export const BACKEND_CONNECT_TABS: BackendConnectTab[] = ['app', 'outside', 'admin'];

export function backendConnectSnippets(target: BackendConnectTarget): BackendConnectSnippet[] {
  const { name, backend_id: backendId, project_id: projectId } = target;
  const url = target.url ?? '<url>';
  const siteUrl = target.site_url ?? '<site_url>';
  const snippets: BackendConnectSnippet[] = [
    {
      id: 'app-install',
      tab: 'app',
      title: 'Install the Convex client and the Kortix SDK',
      file: 'terminal',
      language: 'sh',
      code: 'npm i convex @kortix/sdk',
    },
    {
      id: 'app-backends',
      tab: 'app',
      title: 'List this backend on the App; an App gets viewer tokens only for the backends it lists',
      file: 'terminal',
      language: 'sh',
      code: `kortix apps set <app> --backends ${name}\n# or in kortix.yaml: apps.<app>.backends: [${name}]`,
    },
    {
      id: 'app-env',
      tab: 'app',
      title: 'Commit the public backend URL; a static App reads it at build time',
      file: '.env.production',
      language: 'dotenv',
      code: `VITE_CONVEX_URL=${url}`,
    },
    {
      id: 'app-client',
      tab: 'app',
      title: "Send the viewer's Kortix sign-in token with every call",
      file: 'src/convex.ts',
      language: 'ts',
      code: [
        'import { ConvexReactClient } from "convex/react";',
        'import { kortixAppBackendToken } from "@kortix/sdk";',
        '',
        'export const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL);',
        `convex.setAuth(kortixAppBackendToken(${JSON.stringify(name)}));`,
      ].join('\n'),
    },
    {
      id: 'backend-auth-config',
      tab: 'app',
      title: 'Accept Kortix sign-in tokens in the backend (Kortix sets these variables)',
      file: 'convex/auth.config.ts',
      language: 'ts',
      code: [
        'export default {',
        '  providers: [',
        '    {',
        '      type: "customJwt",',
        '      issuer: process.env.KORTIX_AUTH_ISSUER!,',
        '      applicationID: process.env.KORTIX_AUTH_AUDIENCE!,',
        '      jwks: process.env.KORTIX_AUTH_JWKS!,',
        '      algorithm: "ES256",',
        '    },',
        '  ],',
        '};',
      ].join('\n'),
    },
    {
      id: 'backend-function',
      tab: 'app',
      title: 'Require a signed-in member in every function that reads or writes private data',
      file: 'convex/members.ts',
      language: 'ts',
      code: [
        'import { query } from "./_generated/server";',
        'import { requireKortixMember } from "@kortix/sdk";',
        '',
        'export const me = query({',
        '  args: {},',
        '  handler: async (ctx) => requireKortixMember(await ctx.auth.getUserIdentity()),',
        '});',
      ].join('\n'),
    },
    {
      id: 'outside-token-cli',
      tab: 'outside',
      title: 'Get a 15-minute member token naming you',
      file: 'terminal',
      language: 'sh',
      code: `TOKEN=$(kortix backends token ${name})`,
    },
    {
      id: 'outside-token-sdk',
      tab: 'outside',
      title: 'Or get it in code with a Kortix API key',
      file: 'token.ts',
      language: 'ts',
      code: [
        'import { createKortix } from "@kortix/sdk";',
        '',
        'const kortix = createKortix({',
        '  backendUrl: process.env.KORTIX_API_URL!,',
        '  getToken: async () => process.env.KORTIX_TOKEN!,',
        '});',
        `const { token } = await kortix.project(${JSON.stringify(projectId)}).backends.token(${JSON.stringify(backendId)});`,
      ].join('\n'),
    },
    {
      id: 'outside-query',
      tab: 'outside',
      title: 'Call a query over HTTP',
      file: 'terminal',
      language: 'sh',
      code: [
        `curl -s ${url}/api/query \\`,
        '  -H "Authorization: Bearer $TOKEN" \\',
        '  -H "Content-Type: application/json" \\',
        `  -d '{"path":"members:me","args":{},"format":"json"}'`,
      ].join('\n'),
    },
    {
      id: 'outside-mutation',
      tab: 'outside',
      title: 'Call a mutation over HTTP',
      file: 'terminal',
      language: 'sh',
      code: [
        `curl -s ${url}/api/mutation \\`,
        '  -H "Authorization: Bearer $TOKEN" \\',
        '  -H "Content-Type: application/json" \\',
        `  -d '{"path":"tasks:create","args":{"title":"Hello"},"format":"json"}'`,
      ].join('\n'),
    },
    {
      id: 'outside-http-action',
      tab: 'outside',
      title: 'Call an HTTP action (a route in convex/http.ts)',
      file: 'terminal',
      language: 'sh',
      code: `curl -s ${siteUrl}/hello -H "Authorization: Bearer $TOKEN"`,
    },
    {
      id: 'outside-verify',
      tab: 'outside',
      title: 'Verify the same token on your own server',
      file: 'server.ts',
      language: 'ts',
      code: [
        'import { verifyKortixMemberToken } from "@kortix/sdk";',
        '',
        '// Reads KORTIX_AUTH_ISSUER, KORTIX_AUTH_AUDIENCE and KORTIX_AUTH_JWKS.',
        '// Throws KortixMemberError for a missing, expired or foreign token.',
        'const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";',
        'const member = await verifyKortixMemberToken(bearer);',
      ].join('\n'),
    },
  ];
  if (target.auth_env && Object.keys(target.auth_env).length > 0) {
    const lines = Object.entries(target.auth_env).map(([key, value]) => `${key}=${value}`);
    // A URL issuer serves its key set; older backends carry a placeholder issuer that serves nothing.
    const issuer = target.auth_env.KORTIX_AUTH_ISSUER;
    if (issuer && /\/v1\/backends\/[^/]+$/.test(issuer)) {
      lines.push('', '# Or fetch the key set instead of the inline value (cached per process):', `# KORTIX_AUTH_JWKS=${issuer}/jwks.json`);
    }
    snippets.push({
      id: 'outside-verify-env',
      tab: 'outside',
      title: "Your server's environment (public values, not secrets)",
      file: '.env',
      language: 'dotenv',
      code: lines.join('\n'),
    });
  }
  snippets.push({
    id: 'admin-cli',
    tab: 'admin',
    title: 'Deploy, then use any Convex CLI command with the admin credentials',
    file: 'terminal',
    language: 'sh',
    code: [
      `kortix backends deploy ${name} --dir backends/${name}`,
      '',
      '# Admin URL and key in this shell only. Kortix audits every read.',
      `eval "$(kortix backends env ${name})"`,
      'npx convex function-spec',
      'npx convex data',
      'npx convex env list',
      'npx convex logs',
      '',
      `kortix backends dashboard ${name} --open`,
    ].join('\n'),
  });
  return snippets;
}
