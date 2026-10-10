/**
 * How to reach an App from code: the snippets the web Connect dialog shows and
 * `kortix apps connect <app>` prints. One source, so both stay the same.
 *
 * The App's `capabilities` choose the tabs: `member_tokens` adds the outside
 * tab (sign-in tokens, HTTP calls, verification). Every snippet is generic:
 * an App is an http service, whatever it runs.
 *
 * Pure and secret-free.
 */

export type AppConnectTab = 'app' | 'outside';

/** Stable ids. Hosts title each snippet by its id; the CLI uses `title`. */
export type AppConnectSnippetId =
  | 'app-uses'
  | 'app-client'
  | 'server-verify'
  | 'outside-token-cli'
  | 'outside-token-sdk'
  | 'outside-request'
  | 'outside-verify'
  | 'outside-verify-env';

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
  /** The App's public URL. */
  url: string | null;
  capabilities?: string[];
  /** The values that verify the App's sign-in tokens. Absent on older APIs. */
  auth?: { issuer: string; audience: string; jwks_uri: string } | null;
}

export const APP_CONNECT_TABS: AppConnectTab[] = ['app', 'outside'];

/** A JS identifier for the binding variable: `my-db` → `myDb`. */
function bindingName(slug: string): string {
  return slug.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase()).replace(/^[0-9]/, '_$&');
}

export function appConnectSnippets(target: AppConnectTarget): AppConnectSnippet[] {
  const { slug, app_id: appId, project_id: projectId } = target;
  const can = (capability: string) => target.capabilities?.includes(capability) ?? false;
  const url = target.url ?? '<url>';
  const binding = bindingName(slug);
  const snippets: AppConnectSnippet[] = [
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
      file: 'src/client.ts',
      language: 'ts',
      code: [
        'import { kortixBinding } from "@kortix/sdk";',
        '',
        `const ${binding} = kortixBinding(${JSON.stringify(slug)});`,
        `const response = await fetch(\`\${${binding}.url}/\`, {`,
        `  headers: { authorization: \`Bearer \${await ${binding}.token()}\` },`,
        '});',
      ].join('\n'),
    },
    {
      id: 'server-verify',
      tab: 'app',
      title: 'Require a signed-in member in every request this App serves',
      file: 'server.ts',
      language: 'ts',
      code: [
        'import { verifyKortixToken } from "@kortix/sdk";',
        '',
        '// Reads KORTIX_AUTH_ISSUER, KORTIX_AUTH_AUDIENCE and KORTIX_AUTH_JWKS.',
        'const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";',
        'const member = await verifyKortixToken(bearer);',
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
        id: 'outside-request',
        tab: 'outside',
        title: 'Call the App over HTTP with the token',
        file: 'terminal',
        language: 'sh',
        code: `curl -s ${url}/ -H "Authorization: Bearer $TOKEN"`,
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
  return snippets;
}
