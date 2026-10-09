/**
 * How to reach an App from code: the snippets the web Connect dialog shows and
 * `kortix apps connect <app>` prints. One source, so both stay the same.
 *
 * The App's `capabilities` choose the tabs: `member_tokens` adds the outside
 * tab (sign-in tokens, HTTP calls, verification), `admin_credentials` the
 * admin tab. The code targets an App whose endpoint speaks the Convex client
 * protocol, the one kind with an endpoint today.
 *
 * Pure and secret-free. The admin key never goes in: the web reveals it on an
 * explicit click and the CLI prints it with `kortix apps credentials`, both
 * through the audited credentials route.
 */

export type AppConnectTab = 'app' | 'outside' | 'admin';

/** Stable ids. Hosts title each snippet by its id; the CLI uses `title`. */
export type AppConnectSnippetId =
  | 'app-install'
  | 'app-uses'
  | 'app-client'
  | 'server-auth-config'
  | 'server-function'
  | 'outside-token-cli'
  | 'outside-token-sdk'
  | 'outside-query'
  | 'outside-mutation'
  | 'outside-http-action'
  | 'outside-verify'
  | 'outside-verify-env'
  | 'admin-cli';

export interface AppConnectSnippet {
  id: AppConnectSnippetId;
  tab: AppConnectTab;
  /** English title. */
  title: string;
  /** Where the code goes: a file path, or `terminal`. */
  file: string;
  language: 'ts' | 'sh' | 'dotenv';
  code: string;
}

/** The fields of an App the snippets need (a subset of the API's App object). */
export interface AppConnectTarget {
  app_id: string;
  project_id: string;
  slug: string;
  /** The App's endpoint. `null` until it runs. */
  url: string | null;
  capabilities?: string[];
  /** The values that verify the App's sign-in tokens. Absent on older APIs. */
  auth?: { issuer: string; audience: string; jwks_uri: string } | null;
  instance?: { site_url: string | null } | null;
}

export const APP_CONNECT_TABS: AppConnectTab[] = ['app', 'outside', 'admin'];

/** A JS identifier for the binding variable: `my-db` → `myDb`. */
function bindingName(slug: string): string {
  return slug.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase()).replace(/^[0-9]/, '_$&');
}

export function appConnectSnippets(target: AppConnectTarget): AppConnectSnippet[] {
  const { slug, app_id: appId, project_id: projectId } = target;
  const can = (capability: string) => target.capabilities?.includes(capability) ?? false;
  const url = target.url ?? '<url>';
  const siteUrl = target.instance?.site_url ?? '<site_url>';
  const binding = bindingName(slug);
  const snippets: AppConnectSnippet[] = [
    {
      id: 'app-install',
      tab: 'app',
      title: 'Install the Convex client and the Kortix SDK in the App that uses this one',
      file: 'terminal',
      language: 'sh',
      code: 'npm i convex @kortix/sdk',
    },
    {
      id: 'app-uses',
      tab: 'app',
      title: 'Link it: an App reaches and gets sign-in tokens only for the Apps it uses',
      file: 'terminal',
      language: 'sh',
      code: `kortix apps link <app> --uses ${slug}\n# or in kortix.yaml: apps.<app>.uses: [${slug}]`,
    },
    {
      id: 'app-client',
      tab: 'app',
      title: "Bind it on the App's own origin and send the viewer's Kortix sign-in token",
      file: 'src/convex.ts',
      language: 'ts',
      code: [
        'import { ConvexReactClient } from "convex/react";',
        'import { kortixBinding } from "@kortix/sdk";',
        '',
        `const ${binding} = kortixBinding(${JSON.stringify(slug)});`,
        `export const convex = new ConvexReactClient(${binding}.url);`,
        `convex.setAuth(${binding}.token);`,
      ].join('\n'),
    },
    {
      id: 'server-auth-config',
      tab: 'app',
      title: 'Accept Kortix sign-in tokens in this App (Kortix sets these variables)',
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
      id: 'server-function',
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
  ];
  if (can('member_tokens')) {
    snippets.push(
      {
        id: 'outside-token-cli',
        tab: 'outside',
        title: 'Get a 15-minute sign-in token naming you',
        file: 'terminal',
        language: 'sh',
        code: `TOKEN=$(kortix apps token ${slug})`,
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
          `const { token } = await kortix.project(${JSON.stringify(projectId)}).apps.token(${JSON.stringify(appId)});`,
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
          'import { verifyKortixToken } from "@kortix/sdk";',
          '',
          '// Reads KORTIX_AUTH_ISSUER, KORTIX_AUTH_AUDIENCE and KORTIX_AUTH_JWKS.',
          '// Throws KortixMemberError for a missing, expired or foreign token.',
          'const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";',
          'const member = await verifyKortixToken(bearer);',
        ].join('\n'),
      },
    );
    if (target.auth) {
      snippets.push({
        id: 'outside-verify-env',
        tab: 'outside',
        title: "Your server's environment (public values, not secrets)",
        file: '.env',
        language: 'dotenv',
        code: [
          `KORTIX_AUTH_ISSUER=${target.auth.issuer}`,
          `KORTIX_AUTH_AUDIENCE=${target.auth.audience}`,
          `KORTIX_AUTH_JWKS=${target.auth.jwks_uri}`,
        ].join('\n'),
      });
    }
  }
  if (can('admin_credentials')) {
    snippets.push({
      id: 'admin-cli',
      tab: 'admin',
      title: 'Deploy, then use any Convex CLI command with the admin credentials',
      file: 'terminal',
      language: 'sh',
      code: [
        `kortix apps deploy <dir> --app ${slug}`,
        '',
        '# Admin URL and key in this shell only. Kortix audits every read.',
        `eval "$(kortix apps credentials ${slug})"`,
        'npx convex function-spec',
        'npx convex data',
        'npx convex env list',
        'npx convex logs',
        '',
        `kortix apps dashboard ${slug} --open`,
      ].join('\n'),
    });
  }
  return snippets;
}
