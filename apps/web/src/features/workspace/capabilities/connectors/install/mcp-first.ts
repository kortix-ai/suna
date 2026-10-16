import { checkMcpServerSignIn, type McpServerSignInCheck } from '@kortix/sdk';

/** An app's own hosted MCP server, as the Install dialog opens it. */
export interface McpServerApp {
  name: string;
  url: string;
}

/**
 * The app's own MCP server, when Install should connect through it: the app
 * has one, and the user's consent is the whole sign-in (OAuth with dynamic
 * client registration). Otherwise null, and Install keeps the managed app.
 */
export async function mcpServerFor(
  projectId: string,
  app: { name: string; directMcpUrl?: string | null },
  check: (projectId: string, url: string) => Promise<McpServerSignInCheck> = checkMcpServerSignIn,
): Promise<McpServerApp | null> {
  if (!app.directMcpUrl) return null;
  try {
    const result = await check(projectId, app.directMcpUrl);
    return result.one_click ? { name: app.name, url: app.directMcpUrl } : null;
  } catch {
    return null;
  }
}
