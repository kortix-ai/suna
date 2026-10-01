import { apiResult, callApi, text, type ToolContext, type ToolResult } from './common';

async function toolListProjects(ctx: ToolContext): Promise<ToolResult> {
  const accounts = await callApi(ctx, 'GET', '/v1/accounts');
  if (accounts.status >= 400) return apiResult(accounts);
  const parsed = JSON.parse(accounts.body);
  const list = (Array.isArray(parsed) ? parsed : (parsed.accounts ?? [])) as { account_id: string; name?: string }[];
  const perAccount = await Promise.all(
    list.map(async (account) => {
      const r = await callApi(ctx, 'GET', '/v1/projects', { query: { account_id: account.account_id } });
      const rows = r.status < 400 ? (JSON.parse(r.body) as any[]) : [];
      return rows.map((p) => ({
        project_id: p.project_id,
        name: p.name,
        account: account.name ?? account.account_id,
        account_id: account.account_id,
        repository: p.repo_url ?? null,
        default_branch: p.default_branch ?? null,
        role: p.effective_project_role ?? null,
      }));
    }),
  );
  const projects = perAccount.flat();
  return text(projects.length ? JSON.stringify(projects, null, 2) : 'No projects. Create one in the web app or with `kortix init`.');
}

export async function dispatchProjects(ctx: ToolContext, name: string, input: Record<string, unknown>): Promise<ToolResult | undefined> {
  switch (name) {
    case 'list_projects': return toolListProjects(ctx);
    default: return undefined;
  }
}
