/**
 * Connector, trigger, and project tool calls for the session parity fixture.
 *
 * Story: an agent sets up a small TypeScript web app (`acme-dashboard`). It
 * lists and creates projects, wires the Slack and GitHub connectors, posts to
 * Slack through the connector gateway, and schedules a daily cron trigger.
 *
 * Output shapes follow the parsers the renderers call:
 * - apps/web `lib/utils/kortix-tool-output.ts` (mobile port:
 *   `apps/mobile/lib/session/tools/projects-tool-output.ts`) for
 *   `project_*` and `connector_*`;
 * - apps/web `tool/shared/error-and-connector.tsx#parseConnectorOutput`
 *   (pretty JSON, as `apps/cli/src/connector-gateway/mcp.ts` writes it) for
 *   `kortix-connectors_*`;
 * - the `[status] name | source: detail | agent → agent | last_run: …` line
 *   regex in `triggers-tool.tsx` (mobile: `lib/session/tools/projects-triggers.ts`).
 */

import type { FixtureToolGroup } from '../types';

const PROJECT_ID = 'proj-7f3a9c21e4';

export const CONNECTORS_PROJECTS_TOOL_GROUP: FixtureToolGroup = {
  key: 'connectors-projects',
  prompt:
    'Set up a new acme-dashboard project, connect Slack and GitHub, and schedule a daily build digest that posts to #acme-dashboard every weekday at 09:00 UTC.',
  reasoning:
    'I need a project for acme-dashboard before anything can be scheduled against it, so I will check the existing projects and create one. Slack and GitHub must be configured as connectors, and I will verify the Slack post action with a real call before a trigger depends on it. The digest is a cron trigger at 0 9 * * 1-5 with a prompt that reads GitHub activity and posts to Slack.',
  summary:
    'The acme-dashboard project exists (proj-7f3a9c21e4) and is the selected project. Slack and GitHub are configured through Pipedream, and a test post to #acme-dashboard returned ok. The daily-build-digest cron trigger runs at 08:30 UTC on weekdays and passed a test run. The github-push webhook trigger is active, and the unused weekly-deps-audit trigger is deleted.',
  specs: [
    // ─── Projects ────────────────────────────────────────────────────────────
    {
      renderer: 'project-list-tool.tsx',
      tool: 'project_list',
      input: {},
      output: [
        '## Projects (3)',
        '',
        '| Name | Path | Sessions | Description |',
        '|------|------|----------|-------------|',
        '| **acme-marketing-site** | `/workspace/acme-marketing-site` | 12 | Astro marketing site |',
        '| **acme-api** | `/workspace/acme-api` | 7 | Hono REST API for billing and accounts |',
        '| **acme-dashboard-legacy** | `/workspace/acme-dashboard-legacy` | 2 | Retired CRA dashboard, read-only |',
      ].join('\n'),
      title: 'Projects',
      error: 'Error: Failed to list projects: GET /v1/projects returned 503 Service Unavailable',
      durationMs: 640,
      note: 'Four-column markdown table: `parseProjectListOutput` reads `| **name** | `path` | sessions | description |`. The header row has no `**` and is skipped. Web and mobile render name + path only; sessions and description are parsed but not drawn on either surface.',
    },
    {
      renderer: 'project-create-tool.tsx',
      tool: 'project_create',
      input: {
        name: 'acme-dashboard',
        path: '/workspace/acme-dashboard',
        description: 'Next.js + TypeScript admin dashboard for Acme operations',
      },
      output: [
        `Project **acme-dashboard** at \`/workspace/acme-dashboard\` (${PROJECT_ID}) created.`,
        'Context file: `/workspace/acme-dashboard/.kortix/CONTEXT.md`',
      ].join('\n'),
      title: 'Project Create',
      error: 'Error: Project "acme-dashboard" already exists at /workspace/acme-dashboard',
      durationMs: 1850,
      note: 'Bodyless row on both surfaces. Tap target diverges: web opens the `/workspace` page tab; mobile `projectOpenTarget` opens `page:project:<id>` from the first `proj-[a-z0-9-]+` match in the output, so the output carries the id in `(proj-…)` (also read by web `parseProjectCreateOutput.id`).',
    },
    {
      renderer: 'project-select-tool.tsx',
      tool: 'project_select',
      input: { project: 'acme-dashboard' },
      output: [
        `Project **acme-dashboard** selected (${PROJECT_ID}).`,
        'Path: `/workspace/acme-dashboard`',
        'New sessions and triggers run in this project.',
      ].join('\n'),
      title: 'Project Select',
      error: 'Error: Project not found: acme-dashbord. Run project_list to see available projects.',
      durationMs: 420,
      note: 'Bodyless row. Web title "Workspace Active" + parsed name, tap opens `/workspace`. Mobile has the same trigger but opens `page:project:proj-7f3a9c21e4`; without a `proj-` id in the output mobile falls back to `input.project` as the project id.',
    },
    {
      renderer: 'project-get-tool.tsx',
      tool: 'project_get',
      input: { name: 'acme-dashboard' },
      output: [
        '## acme-dashboard',
        '',
        '**Path:** `/workspace/acme-dashboard`',
        '**Description:** Next.js + TypeScript admin dashboard for Acme operations',
        `**ID:** \`${PROJECT_ID}\``,
        '**Context:** `/workspace/acme-dashboard/.kortix/CONTEXT.md` ✓',
        '',
        '### Sessions',
        '- running: 1',
        '- completed: 0',
        '- failed: 0',
        '',
        '### Stack',
        '- Next.js 16 (App Router), TypeScript 5.9, Tailwind CSS 4',
        '- pnpm workspace, Vitest, Playwright',
      ].join('\n'),
      title: 'Project',
      error: 'Error: Project not found: acme-dashboard',
      durationMs: 380,
      note: 'Both surfaces show the raw output in an OutputBlock; `parseProjectGetOutput` exists on both but no renderer calls it. Trigger subtitle reads `input.name` on web and mobile; the SDK `parts.ts` label reads `input.name || input.project`, so the input carries `name`.',
    },
    {
      renderer: 'project-get-tool.tsx',
      tool: 'project_update',
      input: {
        name: 'acme-dashboard',
        description: 'Acme operations dashboard: builds, deploys, and on-call digest',
      },
      output: [
        'Project **acme-dashboard** updated.',
        '',
        '## acme-dashboard',
        '',
        '**Path:** `/workspace/acme-dashboard`',
        '**Description:** Acme operations dashboard: builds, deploys, and on-call digest',
        `**ID:** \`${PROJECT_ID}\``,
      ].join('\n'),
      title: 'Project',
      error: 'Error: description must be 280 characters or fewer (got 312)',
      durationMs: 510,
      note: '`project_update` is registered on the `project_get` renderer: same title ("Workspace Details") and raw OutputBlock body.',
    },
    {
      renderer: 'project-delete-tool.tsx',
      tool: 'project_delete',
      input: { project: 'acme-dashboard-legacy' },
      output:
        'Project deletion is disabled for agents. Archive acme-dashboard-legacy from Project settings in the Kortix dashboard.',
      title: 'Workspace Delete Disabled',
      error: 'Error: project_delete is disabled in this workspace',
      durationMs: 150,
      note: 'Bodyless row on both surfaces: "Workspace · Workspace delete disabled" with `input.project` as the arg. The output and the error text are never drawn.',
    },

    // ─── Legacy connector tools (connector_*) ────────────────────────────────
    {
      renderer: 'connector-list-tool.tsx',
      tool: 'connector_list',
      input: {},
      output: [
        'Connectors (3):',
        '',
        '| Name | Description | Source |',
        '|------|-------------|--------|',
        '| slack | Post messages and read channels in the Acme workspace | pipedream |',
        '| github | Issues, pull requests, and Actions for acme-inc | pipedream |',
        '| linear | Issue tracking for the Acme product team | mcp |',
      ].join('\n'),
      error: 'Error: connectors directory is unreadable: EACCES: permission denied, scandir \'/workspace/.kortix/connectors\'',
      durationMs: 300,
      note: 'Markdown `| Name | Description | Source |` table. No `filter` in the input, so the subtitle is the count ("3 connectors"); a `filter` replaces it with "Filter: <filter>" on both surfaces.',
    },
    {
      renderer: 'connector-setup-tool.tsx',
      tool: 'oc-connector_setup',
      input: {
        connectors: [
          { name: 'slack', source: 'pipedream', app: 'slack', env: 'SLACK_BOT_TOKEN' },
          { name: 'github', source: 'pipedream', app: 'github', env: 'GITHUB_TOKEN' },
        ],
      },
      output: [
        'Created/updated 2 connectors:',
        'slack (pipedream)',
        'github (pipedream)',
        '',
        'Connect the accounts in Settings → Connectors to finish authorization.',
      ].join('\n'),
      error: 'Error: Pipedream app "githb" not found',
      durationMs: 2100,
      note: '`oc-` alias. `parseConnectorSetupOutput` needs "Created/updated N connectors" for the count and one `name (source)` line per connector. The renderer ignores the input.',
    },
    {
      renderer: 'connector-get-tool.tsx',
      tool: 'connector_get',
      input: { name: 'slack' },
      output: [
        'name: slack',
        'description: Post messages and read channels in the Acme workspace',
        'source: pipedream',
        'env: SLACK_BOT_TOKEN',
        'notes:',
        'The bot is invited to #eng-alerts and #acme-dashboard. Invite it before posting to any other channel.',
      ].join('\n'),
      error: 'Error: Connector not found: slak',
      durationMs: 260,
      note: 'PARSER BUG (web `kortix-tool-output.ts` and mobile `projects-tool-output.ts`, identical): the notes regex `/^notes:\\s*\\n([\\s\\S]*?)$/` has no `m` flag, so `^` only matches at the start of the output and `notes` is always undefined for this realistic shape. Name, description, source badge, and env render on both surfaces; the notes block renders on neither. Title is the parsed name; `input.name === data.name`, so the subtitle is the description.',
    },

    // ─── Connector gateway (kortix-connectors_*) ─────────────────────────────
    {
      renderer: 'connector-tools.tsx',
      tool: 'kortix-connectors_connectors',
      input: {},
      output: JSON.stringify(
        {
          connectors: [
            { slug: 'slack', name: 'Slack', provider: 'pipedream', status: 'active', tools: 14 },
            { slug: 'github', name: 'GitHub', provider: 'pipedream', status: 'active', tools: 32 },
            { slug: 'linear', name: 'Linear', provider: 'mcp', status: 'disabled', tools: 0 },
          ],
        },
        null,
        2,
      ),
      error: 'MCP error -32603: connector catalog request failed: 401 Unauthorized',
      durationMs: 720,
      note: 'Shape from `apps/cli/src/connector-gateway/mcp.ts` `connectors` meta-tool. `active` renders in the success tint, `disabled` in muted. No logo URL is read by either surface.',
    },
    {
      renderer: 'connector-tools.tsx',
      tool: 'kortix-connectors_discover',
      input: { query: 'post a slack message', limit: 5 },
      output: JSON.stringify(
        {
          matches: [
            {
              tool: 'slack.chat.postMessage',
              risk: 'write',
              description: 'Send a message to a channel, a private group, or a direct message.',
            },
            {
              tool: 'slack.chat.scheduleMessage',
              risk: 'write',
              description: 'Schedule a message to be sent to a channel at a later time.',
            },
            {
              tool: 'slack.conversations.list',
              risk: 'read',
              description: 'List the public and private channels the bot can see.',
            },
          ],
        },
        null,
        2,
      ),
      error: 'MCP error -32603: connector search failed: 502 Bad Gateway',
      durationMs: 540,
      note: 'Three matches with `write` (warning tint) and `read` (success tint) risk badges.',
    },
    {
      renderer: 'connector-tools.tsx',
      tool: 'kortix-connectors_describe',
      input: { tool: 'slack.chat.postMessage' },
      output: JSON.stringify(
        {
          tool: 'slack.chat.postMessage',
          risk: 'write',
          description:
            'Send a message to a channel. Pass thread_ts to reply in a thread. Markdown uses Slack mrkdwn.',
          inputSchema: {
            type: 'object',
            properties: {
              channel: { type: 'string', description: 'Channel name (#acme-dashboard) or ID (C07ACMEDASH).' },
              text: { type: 'string', description: 'Message text in Slack mrkdwn.' },
              thread_ts: { type: 'string', description: 'Parent message timestamp to reply in a thread.' },
              unfurl_links: { type: 'boolean', description: 'Expand link previews. Default false.' },
            },
            required: ['channel', 'text'],
            additionalProperties: false,
          },
        },
        null,
        2,
      ),
      error: 'unknown tool "slack.chat.postMesage" — run discover to list tools',
      durationMs: 310,
      note: 'Tool path, risk badge, and description stay open; the input schema folds on both surfaces.',
    },
    {
      renderer: 'connector-tools.tsx',
      tool: 'kortix-connectors_call',
      input: {
        connector: 'slack',
        action: 'chat.postMessage',
        args: {
          channel: '#acme-dashboard',
          text: 'Daily build digest is scheduled: weekdays at 09:00 UTC, first run tomorrow.',
        },
      },
      output: JSON.stringify(
        {
          ok: true,
          status: 'ok',
          risk: 'write',
          execution_id: 'cex_01J8ZKQ4M2V7T3ACME',
          data: {
            ok: true,
            channel: 'C07ACMEDASH',
            ts: '1789641600.004211',
            message: {
              type: 'message',
              bot_id: 'B07KORTIX',
              text: 'Daily build digest is scheduled: weekdays at 09:00 UTC, first run tomorrow.',
            },
          },
        },
        null,
        2,
      ),
      error: 'slack.chat.postMessage failed: not_in_channel — invite the bot to #acme-dashboard first',
      durationMs: 1400,
      note: '`ConnectorCallResult` shape (packages/sdk `projects-client/connectors.ts`). Header "slack.chat.postMessage · WRITE · OK"; Request (args) folds; Response shows `data`.',
    },

    // ─── Retired integration-* tools ─────────────────────────────────────────
    {
      renderer: 'removed-connector-tool.tsx',
      tool: 'integration-run',
      input: { app: 'github', action: 'list_workflow_runs', params: { repo: 'acme-inc/acme-dashboard', per_page: 3 } },
      output: JSON.stringify(
        {
          total_count: 3,
          workflow_runs: [
            { id: 11873201, name: 'CI', head_branch: 'main', status: 'completed', conclusion: 'success' },
            { id: 11873144, name: 'CI', head_branch: 'feat/charts', status: 'completed', conclusion: 'failure' },
            { id: 11872990, name: 'Deploy preview', head_branch: 'feat/charts', status: 'in_progress', conclusion: null },
          ],
        },
        null,
        2,
      ),
      error: 'Error: integration-run is no longer available. Use kortix-connectors_call instead.',
      durationMs: 900,
      note: 'Every `integration-*` tool renders the same "Legacy Connector Tool · removed" row. This JSON output takes the RawOutputBlock branch of `ToolOutputFallback`.',
    },
    {
      renderer: 'removed-connector-tool.tsx',
      tool: 'integration-search',
      input: { query: 'slack' },
      output: [
        'Found 2 integrations for "slack":',
        '',
        '- **Slack** (`slack`): messages, channels, users',
        '- **Slack Bot** (`slack_bot`): bot-token messaging only',
      ].join('\n'),
      error: 'Error: integration-search is no longer available. Use kortix-connectors_discover instead.',
      durationMs: 450,
      states: ['completed'],
      note: 'Short non-JSON output: the markdown-card branch of `ToolOutputFallback`.',
    },
    {
      renderer: 'removed-connector-tool.tsx',
      tool: 'integration-connect',
      input: { app: 'github' },
      output: JSON.stringify({
        success: false,
        error: 'Legacy integrations were removed',
        hint: 'Declare the connector in kortix.yaml and run connector_setup.',
      }),
      error: 'Error: integration-connect is no longer available.',
      durationMs: 120,
      states: ['completed'],
      note: '`{success:false,error,hint}` contract: the JsonFailureOutputCard branch of `ToolOutputFallback`.',
    },

    // ─── Triggers ────────────────────────────────────────────────────────────
    {
      renderer: 'triggers-tool.tsx',
      tool: 'triggers',
      input: {
        action: 'create',
        name: 'daily-build-digest',
        source_type: 'cron',
        cron: '0 9 * * 1-5',
        timezone: 'UTC',
        agent: 'kortix',
        prompt:
          'Summarize yesterday on acme-inc/acme-dashboard: merged pull requests, failed CI runs on main, and open issues labeled p0. Post the summary to #acme-dashboard with the slack connector. Keep it under 12 lines and link each pull request.',
      },
      output: [
        'Trigger created: daily-build-digest',
        '[active] daily-build-digest | cron: 0 9 * * 1-5 | kortix → kortix | last_run: never',
        'Next run: 2026-09-18T09:00:00Z',
      ].join('\n'),
      error: 'Error: Invalid cron expression "0 9 * * 1-8": day-of-week must be 0-7',
      durationMs: 980,
      note: 'Action-based form. Web and mobile read `input.action`; `create` gives "Create Trigger", the `cron` arg, the parsed trigger row, and the folded Prompt section. The "Next run" line does not start with `[` and is not drawn.',
    },
    {
      renderer: 'triggers-tool.tsx',
      tool: 'trigger_create',
      input: {
        action: 'create',
        name: 'github-push',
        source_type: 'webhook',
        path: '/hooks/acme-dashboard/github-push',
        agent: 'kortix',
        prompt: 'A push landed on acme-inc/acme-dashboard. If CI fails on main, post the failing job and its log tail to #eng-alerts.',
      },
      output: [
        'Trigger created: github-push',
        '[paused] github-push | webhook: /hooks/acme-dashboard/github-push | kortix → kortix | last_run: never',
        'Paused until the GITHUB_WEBHOOK_SECRET secret is set.',
      ].join('\n'),
      error: 'Error: A trigger named "github-push" already exists in acme-dashboard',
      durationMs: 870,
      note: 'Discrete tool. Both surfaces key the title off `input.action` and default to `list` ("List Triggers") when it is absent, so the input carries `action: "create"` (as in web `triggers-tool.test.tsx`). Webhook source: globe icon, `paused` warning badge.',
    },
    {
      renderer: 'triggers-tool.tsx',
      tool: 'trigger_list',
      input: {},
      output: [
        'TRIGGERS (3)',
        '[active] daily-build-digest | cron: 0 9 * * 1-5 | kortix → kortix | last_run: never',
        '[paused] github-push | webhook: /hooks/acme-dashboard/github-push | kortix → kortix | last_run: never',
        '[disabled] weekly-deps-audit | cron: 0 6 * * 1 | kortix → kortix | last_run: 2026-09-14T06:00:12Z',
      ].join('\n'),
      error: 'Error: Failed to list triggers: GET /v1/projects/proj-7f3a9c21e4/triggers returned 500',
      durationMs: 350,
      note: 'No `action`: the default `list` branch. `TRIGGERS (3)` gives "3 triggers" and the `3` arg. Badges: active success, paused warning, disabled muted.',
    },
    {
      renderer: 'triggers-tool.tsx',
      tool: 'trigger_get',
      input: { action: 'get', trigger_id: 'trg_01J8ZM3F7Q2DAILYDIGEST' },
      output: [
        'Trigger: daily-build-digest',
        'ID: trg_01J8ZM3F7Q2DAILYDIGEST',
        'Status: active',
        'Source: cron 0 9 * * 1-5 (UTC)',
        'Agent: kortix',
        'Project: acme-dashboard',
        'Next run: 2026-09-18T09:00:00Z',
        'Last run: never',
        '',
        'Prompt:',
        'Summarize yesterday on acme-inc/acme-dashboard: merged pull requests, failed CI runs on main, and open issues labeled p0.',
      ].join('\n'),
      error: 'Error: Trigger not found: trg_01J8ZM3F7Q2DAILYDIGEST',
      durationMs: 240,
      note: 'No line starts with `[`, so both surfaces show the raw detail text in an OutputBlock. The subtitle truncates the id at 20 characters.',
    },
    {
      renderer: 'triggers-tool.tsx',
      tool: 'trigger_update',
      input: { action: 'update', trigger_id: 'trg_01J8ZM3F7Q2DAILYDIGEST', name: 'daily-build-digest', cron: '30 8 * * 1-5' },
      output: [
        'Trigger updated: daily-build-digest',
        '[active] daily-build-digest | cron: 30 8 * * 1-5 | kortix → kortix | last_run: never',
      ].join('\n'),
      error: 'Error: Invalid cron expression "30 8 * *": expected 5 fields, got 4',
      durationMs: 420,
    },
    {
      renderer: 'triggers-tool.tsx',
      tool: 'trigger_test',
      input: { action: 'test', trigger_id: 'trg_01J8ZM3F7Q2DAILYDIGEST', name: 'daily-build-digest' },
      output: [
        'Test run started for daily-build-digest.',
        'Session: ses_01J8ZN0TESTDIGEST',
        'Result: posted 9 lines to #acme-dashboard (ts 1789641733.001900)',
      ].join('\n'),
      error: 'Error: Test run failed: slack connector is not authorized for this project',
      durationMs: 6200,
      note: 'Prose result: the raw OutputBlock body with the "tested" arg.',
    },
    {
      renderer: 'triggers-tool.tsx',
      tool: 'trigger_pause',
      input: { action: 'pause', trigger_id: 'trg_01J8ZM3F7Q2WEEKLYDEPS', name: 'weekly-deps-audit' },
      output: [
        'Trigger paused: weekly-deps-audit',
        '[paused] weekly-deps-audit | cron: 0 6 * * 1 | kortix → kortix | last_run: 2026-09-14T06:00:12Z',
      ].join('\n'),
      error: 'Error: Trigger not found: trg_01J8ZM3F7Q2WEEKLYDEPS',
      durationMs: 210,
    },
    {
      renderer: 'triggers-tool.tsx',
      tool: 'trigger_resume',
      input: { action: 'resume', trigger_id: 'trg_01J8ZM3F7Q2GITHUBPUSH', name: 'github-push' },
      output: [
        'Trigger resumed: github-push',
        '[active] github-push | webhook: /hooks/acme-dashboard/github-push | kortix → kortix | last_run: never',
      ].join('\n'),
      error: 'Error: Cannot resume github-push: required secret GITHUB_WEBHOOK_SECRET is not set',
      durationMs: 230,
    },
    {
      renderer: 'triggers-tool.tsx',
      tool: 'trigger_delete',
      input: { action: 'delete', trigger_id: 'trg_01J8ZM3F7Q2WEEKLYDEPS' },
      output: 'Trigger deleted: weekly-deps-audit (trg_01J8ZM3F7Q2WEEKLYDEPS)',
      error: 'Error: Trigger not found: trg_01J8ZM3F7Q2WEEKLYDEPS',
      durationMs: 190,
      note: 'Output contains "deleted": subtitle "Deleted", `deleted` arg, raw OutputBlock body. While running, the subtitle is the first 8 id characters.',
    },
  ],
};
