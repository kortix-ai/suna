/**
 * The marketplace catalog — a static list of templates.
 *
 * A template is a public GitHub repository whose `kortix.yaml` declares agents,
 * skills, connectors and triggers. Installing one MERGES that declaration into a
 * project through an agent session that opens a change request
 * (`../projects/routes/marketplace.ts`). Nothing about a template lives in the
 * database: this list IS the catalog, and the repository at `resolved_sha` is
 * the source the install reads.
 *
 * Every card field was derived from the repository's own `kortix.yaml` at
 * `resolved_sha` on 2026-09-03, with the same parsers the runtime uses. To add
 * or bump a template: read its manifest at the commit you want, append or
 * replace the entry, and keep `resolved_sha` on that exact commit. The install
 * prompt tells the agent to read files at that sha, so a moved branch can never
 * disagree with the card.
 *
 * A leaf module — no config, no db — so the routes and the prompt builder stay
 * unit-testable without booting the API's env graph.
 */

/** One agent a template contributes. */
export interface MarketplaceTemplateAgent {
  name: string;
  description: string | null;
}

/** One trigger a template contributes — the cadence its card advertises. */
export interface MarketplaceTemplateTrigger {
  slug: string;
  name: string;
  type: string;
  cron: string | null;
  agent: string;
  enabled: boolean;
}

/** One connector a template NEEDS. A requirement, not a connection state. */
export interface MarketplaceTemplateConnector {
  slug: string;
  provider: string;
  app: string | null;
}

/** One template, as the wire carries it. */
export interface MarketplaceTemplate {
  slug: string;
  title: string;
  description: string | null;
  /** `owner/repo`. */
  repo: string;
  repo_owner: string;
  repo_name: string;
  /** The branch or tag pinned, or null for the default branch. */
  git_ref: string | null;
  /** The commit the card was derived from and the install reads. */
  resolved_sha: string;
  agents: MarketplaceTemplateAgent[];
  triggers: MarketplaceTemplateTrigger[];
  connectors: MarketplaceTemplateConnector[];
  skills: string[];
  env_required: string[];
}

/** A catalog entry: the card plus the manifest the install prompt embeds. */
export interface MarketplaceCatalogEntry extends MarketplaceTemplate {
  manifest: Record<string, unknown>;
}

export const MARKETPLACE_CATALOG: readonly MarketplaceCatalogEntry[] = [
  {
    slug: 'sre-oncall',
    title: 'SRE On-Call',
    description:
      'Automated site reliability engineer: sweeps monitoring connectors on a schedule and on inbound alerts, files deduplicated incidents as GitHub issues, and opens draft pull requests for the fixes it can justify.',
    repo: 'DimitrijeGlibic/sre-oncall',
    repo_owner: 'DimitrijeGlibic',
    repo_name: 'sre-oncall',
    git_ref: null,
    resolved_sha: '7ad17b3d02aee7f7859370679cd353dc0916fc6c',
    agents: [
      {
        name: 'kortix',
        description: null,
      },
      {
        name: 'sre',
        description: null,
      },
    ],
    triggers: [
      {
        slug: 'sre-alert-webhook',
        name: 'SRE alert webhook',
        type: 'webhook',
        cron: null,
        agent: 'sre',
        enabled: true,
      },
      {
        slug: 'sre-sweep-evening',
        name: 'SRE sweep (evening)',
        type: 'cron',
        cron: '0 30 19 * * *',
        agent: 'sre',
        enabled: true,
      },
      {
        slug: 'sre-sweep-morning',
        name: 'SRE sweep (morning)',
        type: 'cron',
        cron: '0 30 7 * * *',
        agent: 'sre',
        enabled: true,
      },
    ],
    connectors: [
      {
        slug: 'better_stack',
        provider: 'composio',
        app: 'better_stack',
      },
      {
        slug: 'bugsnag',
        provider: 'composio',
        app: 'bugsnag',
      },
      {
        slug: 'datadog',
        provider: 'composio',
        app: 'datadog',
      },
      {
        slug: 'elasticsearch',
        provider: 'composio',
        app: 'elasticsearch',
      },
      {
        slug: 'github',
        provider: 'composio',
        app: 'github',
      },
      {
        slug: 'new_relic',
        provider: 'composio',
        app: 'new_relic',
      },
      {
        slug: 'pagerduty',
        provider: 'composio',
        app: 'pagerduty',
      },
      {
        slug: 'rollbar',
        provider: 'composio',
        app: 'rollbar',
      },
      {
        slug: 'sentry',
        provider: 'composio',
        app: 'sentry',
      },
    ],
    skills: ['kortix-cli', 'kortix-connectors', 'kortix-memory', 'kortix-slack', 'sre-triage'],
    env_required: [],
    manifest: {
      kortix_version: 2,
      default_agent: 'sre',
      project: {
        name: 'SRE On-Call',
        description:
          'Automated site reliability engineer: sweeps monitoring connectors on a schedule and on inbound alerts, files deduplicated incidents as GitHub issues, and opens draft pull requests for the fixes it can justify.',
      },
      env: {
        required: [],
        optional: ['SRE_ALERT_WEBHOOK_SECRET'],
      },
      opencode: {
        config_dir: '.kortix/opencode',
      },
      agents: {
        sre: {
          connectors: [
            'sentry',
            'better_stack',
            'datadog',
            'new_relic',
            'bugsnag',
            'rollbar',
            'elasticsearch',
            'pagerduty',
            'github',
          ],
          secrets: ['SRE_ALERT_WEBHOOK_SECRET'],
          skills: [
            'sre-triage',
            'kortix-cli',
            'kortix-connectors',
            'kortix-memory',
            'kortix-slack',
          ],
          kortix_cli: [
            'project.read',
            'project.cr.open',
            'project.session.read',
            'project.trigger.read',
            'project.connector.read',
          ],
        },
        kortix: {
          connectors: 'all',
          secrets: 'all',
          kortix_cli: 'all',
          skills: 'all',
        },
      },
      triggers: [
        {
          slug: 'sre-sweep-morning',
          name: 'SRE sweep (morning)',
          type: 'cron',
          agent: 'sre',
          enabled: true,
          cron: '0 30 7 * * *',
          timezone: 'UTC',
          session_mode: 'fresh',
          prompt:
            'Run the scheduled reliability sweep. Window: {{ cron.last_scheduled_for }} → {{ cron.scheduled_for }} ({{ cron.timezone }}). If {{ cron.last_scheduled_for }} is empty, use the last 24 hours.\n\nLoad the `sre-triage` skill and read `.kortix/sre/config.yaml`.\nCollect error, latency, throughput and availability signals from\nevery enabled AND authorized monitoring connector; skip any that\nreport needs_auth and note it once. Dedupe each signal against open\nGitHub issues carrying the `sre` label, using its fingerprint. File\none GitHub issue per new incident (cap:\nschedule.max_new_incidents_per_run) with real evidence — counts,\nwindow, source deep link, redacted sample. Then attempt a fix and\nopen a DRAFT PR for the incidents you genuinely understand, capped\nby schedule.max_fix_attempts_per_run. Never merge, never approve,\nnever force-push, never close an issue you did not open, never mute\na monitor. Notify on Slack if notify.slack_channel is set. End the\nrun silently if nothing is new and nothing regressed.',
        },
        {
          slug: 'sre-sweep-evening',
          name: 'SRE sweep (evening)',
          type: 'cron',
          agent: 'sre',
          enabled: true,
          cron: '0 30 19 * * *',
          timezone: 'UTC',
          session_mode: 'fresh',
          prompt:
            'Run the scheduled reliability sweep. Window: {{ cron.last_scheduled_for }} → {{ cron.scheduled_for }} ({{ cron.timezone }}). If {{ cron.last_scheduled_for }} is empty, use the last 24 hours.\n\nLoad the `sre-triage` skill and read `.kortix/sre/config.yaml`.\nCollect error, latency, throughput and availability signals from\nevery enabled AND authorized monitoring connector; skip any that\nreport needs_auth and note it once. Dedupe each signal against open\nGitHub issues carrying the `sre` label, using its fingerprint. File\none GitHub issue per new incident (cap:\nschedule.max_new_incidents_per_run) with real evidence — counts,\nwindow, source deep link, redacted sample. Then attempt a fix and\nopen a DRAFT PR for the incidents you genuinely understand, capped\nby schedule.max_fix_attempts_per_run. Never merge, never approve,\nnever force-push, never close an issue you did not open, never mute\na monitor. Notify on Slack if notify.slack_channel is set. End the\nrun silently if nothing is new and nothing regressed.',
        },
        {
          slug: 'sre-alert-webhook',
          name: 'SRE alert webhook',
          type: 'webhook',
          agent: 'sre',
          enabled: true,
          secret_env: 'SRE_ALERT_WEBHOOK_SECRET',
          session_mode: 'fresh',
          prompt:
            "An external monitor alerted at {{ fired_at }} (user-agent: {{ headers.user_agent }}).\n\nPayload:\n{{ body }}\n\nLoad the `sre-triage` skill and read `.kortix/sre/config.yaml`\nfor the target repo and thresholds. Treat this alert as a tip, not\nas the whole story: triage it first, then sweep the last\nschedule.webhook_lookback across your authorized monitoring\nconnectors for corroborating or related signals. Then follow the\nsame rules as the scheduled sweep — dedupe by fingerprint against\nopen `sre` issues, file one issue per new incident with real\nevidence, attempt a fix and open a DRAFT PR only where you are\nconfident. Never merge, never approve, never force-push, never\nclose an issue you did not open, never mute a monitor. Notify on\nSlack if notify.slack_channel is set. If the alert is a duplicate\nof an open incident and nothing materially changed, update that\nissue's numbers only if they moved, then end silently.",
        },
      ],
      connectors: [
        {
          slug: 'sentry',
          provider: 'composio',
          app: 'sentry',
        },
        {
          slug: 'better_stack',
          provider: 'composio',
          app: 'better_stack',
        },
        {
          slug: 'datadog',
          provider: 'composio',
          app: 'datadog',
        },
        {
          slug: 'new_relic',
          provider: 'composio',
          app: 'new_relic',
        },
        {
          slug: 'bugsnag',
          provider: 'composio',
          app: 'bugsnag',
        },
        {
          slug: 'rollbar',
          provider: 'composio',
          app: 'rollbar',
        },
        {
          slug: 'elasticsearch',
          provider: 'composio',
          app: 'elasticsearch',
        },
        {
          slug: 'pagerduty',
          provider: 'composio',
          app: 'pagerduty',
        },
        {
          slug: 'github',
          provider: 'composio',
          app: 'github',
        },
      ],
    },
  },
  {
    slug: 'kortix-candidate-screening',
    title: 'Candidate Screening',
    description:
      "Daily agent that screens candidates from every connected hiring platform: reads each CV, verifies its claims against the candidate's public LinkedIn, GitHub and website, scores against the role's written rubric, and writes a per-candidate summary for a human recruiter to decide on. Never contacts candidates, never writes to the ATS, never rejects anyone.",
    repo: 'DimitrijeGlibic/kortix-candidate-screening',
    repo_owner: 'DimitrijeGlibic',
    repo_name: 'kortix-candidate-screening',
    git_ref: null,
    resolved_sha: '79e8eec52802a54d40fb6ed91611f099d62b4212',
    agents: [
      {
        name: 'candidate-screener',
        description: null,
      },
    ],
    triggers: [
      {
        slug: 'daily-sweep',
        name: 'Daily candidate screening sweep',
        type: 'cron',
        cron: '0 0 8 * * *',
        agent: 'candidate-screener',
        enabled: true,
      },
    ],
    connectors: [
      {
        slug: 'ashby',
        provider: 'composio',
        app: 'ashby',
      },
      {
        slug: 'breezy_hr',
        provider: 'composio',
        app: 'breezy_hr',
      },
      {
        slug: 'github',
        provider: 'composio',
        app: 'github',
      },
      {
        slug: 'greenhouse',
        provider: 'composio',
        app: 'greenhouse',
      },
      {
        slug: 'lever',
        provider: 'composio',
        app: 'lever',
      },
      {
        slug: 'linkedin',
        provider: 'composio',
        app: 'linkedin',
      },
      {
        slug: 'recruitee',
        provider: 'composio',
        app: 'recruitee',
      },
      {
        slug: 'slack',
        provider: 'composio',
        app: 'slack',
      },
      {
        slug: 'workable',
        provider: 'composio',
        app: 'workable',
      },
    ],
    skills: [],
    env_required: [],
    manifest: {
      kortix_version: 2,
      default_agent: 'candidate-screener',
      project: {
        name: 'Candidate Screening',
        description:
          "Daily agent that screens candidates from every connected hiring platform: reads each CV, verifies its claims against the candidate's public LinkedIn, GitHub and website, scores against the role's written rubric, and writes a per-candidate summary for a human recruiter to decide on. Never contacts candidates, never writes to the ATS, never rejects anyone.",
      },
      env: {
        required: [],
        optional: ['SLACK_CHANNEL', 'MAX_CANDIDATES_PER_RUN'],
      },
      opencode: {
        config_dir: '.kortix/opencode',
      },
      triggers: [
        {
          slug: 'daily-sweep',
          name: 'Daily candidate screening sweep',
          type: 'cron',
          agent: 'candidate-screener',
          enabled: true,
          cron: '0 0 8 * * *',
          timezone: 'UTC',
          prompt:
            'Run one candidate screening sweep. Load the `screening-rubric`, `profile-verification` and `summary-format` skills, then follow your instructions end to end: pull newly applied candidates from every authorized hiring-platform connector, gather their public LinkedIn / GitHub / website evidence, cross-check the CV claims against it, score each candidate against `config/rubric.md`, write the per-candidate summaries and run index under `reports/<YYYY-MM-DD>/`, post the Slack digest if `SLACK_CHANNEL` is set, and update `state/screened.json` (never marking unscreened candidates as screened).',
        },
      ],
      connectors: [
        {
          slug: 'greenhouse',
          provider: 'composio',
          app: 'greenhouse',
          name: 'Greenhouse',
        },
        {
          slug: 'lever',
          provider: 'composio',
          app: 'lever',
          name: 'Lever',
        },
        {
          slug: 'ashby',
          provider: 'composio',
          app: 'ashby',
          name: 'Ashby',
        },
        {
          slug: 'workable',
          provider: 'composio',
          app: 'workable',
          name: 'Workable',
        },
        {
          slug: 'breezy_hr',
          provider: 'composio',
          app: 'breezy_hr',
          name: 'Breezy HR',
        },
        {
          slug: 'recruitee',
          provider: 'composio',
          app: 'recruitee',
          name: 'Recruitee',
        },
        {
          slug: 'linkedin',
          provider: 'composio',
          app: 'linkedin',
          name: 'LinkedIn',
        },
        {
          slug: 'github',
          provider: 'composio',
          app: 'github',
          name: 'GitHub',
        },
        {
          slug: 'slack',
          provider: 'composio',
          app: 'slack',
          name: 'Slack',
        },
      ],
      agents: {
        'candidate-screener': {
          connectors: [
            'greenhouse',
            'lever',
            'ashby',
            'workable',
            'breezy_hr',
            'recruitee',
            'linkedin',
            'github',
            'slack',
          ],
          secrets: 'none',
          kortix_cli: ['project.read'],
          skills: 'all',
        },
      },
    },
  },
  {
    slug: 'kortix-slow-query-optimizer',
    title: 'Slow Query Optimizer',
    description:
      'Daily agent that finds the slowest queries in your PostgreSQL database (Supabase, Neon, RDS, self-hosted), diagnoses them with EXPLAIN, files a GitHub issue or Linear card with the evidence and a proposed fix, and drafts a behavior-preserving performance PR. Never merges, never mutates production schema directly.',
    repo: 'DimitrijeGlibic/kortix-slow-query-optimizer',
    repo_owner: 'DimitrijeGlibic',
    repo_name: 'kortix-slow-query-optimizer',
    git_ref: null,
    resolved_sha: '5e934212a71024c009ae366d3f4facd828180fce',
    agents: [
      {
        name: 'slow-query-optimizer',
        description: null,
      },
    ],
    triggers: [
      {
        slug: 'daily-triage',
        name: 'Daily slow-query triage',
        type: 'cron',
        cron: '0 0 9 * * *',
        agent: 'slow-query-optimizer',
        enabled: false,
      },
    ],
    connectors: [
      {
        slug: 'github',
        provider: 'composio',
        app: 'github',
      },
      {
        slug: 'linear',
        provider: 'composio',
        app: 'linear',
      },
      {
        slug: 'postgres',
        provider: 'composio',
        app: 'postgres',
      },
    ],
    skills: [],
    env_required: [],
    manifest: {
      kortix_version: 2,
      default_agent: 'slow-query-optimizer',
      project: {
        name: 'Slow Query Optimizer',
        description:
          'Daily agent that finds the slowest queries in your PostgreSQL database (Supabase, Neon, RDS, self-hosted), diagnoses them with EXPLAIN, files a GitHub issue or Linear card with the evidence and a proposed fix, and drafts a behavior-preserving performance PR. Never merges, never mutates production schema directly.',
      },
      env: {
        required: [],
        optional: [
          'GITHUB_REPO',
          'SLOW_QUERY_LIMIT',
          'MIN_MEAN_MS',
          'MIN_TOTAL_MS',
          'MAX_CARDS_PER_RUN',
          'POSTGRES_CONNECTION_STRING',
          'GITHUB_PAT',
          'LINEAR_API_KEY',
        ],
      },
      opencode: {
        config_dir: '.kortix/opencode',
      },
      triggers: [
        {
          slug: 'daily-triage',
          name: 'Daily slow-query triage',
          type: 'cron',
          agent: 'slow-query-optimizer',
          enabled: false,
          cron: '0 0 9 * * *',
          timezone: 'UTC',
          prompt:
            "Run one daily slow-query triage loop.\n\nLoad the `query-triage-playbook` and `safe-perf-pr-playbook` skills, read\n`state/ledger.json`, pull and rank the slowest queries from\n`pg_stat_statements` (read-only), investigate the top offenders with EXPLAIN,\ndedupe against open issues and PRs, file at most MAX_CARDS_PER_RUN cards on\nGitHub or Linear, draft behavior-preserving perf PRs where the owning repo is\nconnected, and write `state/last-run.json` plus today's digest under\n`state/reports/`.\n\nNever merge a PR, never push to the default branch, never run structural DDL\n(only `create extension if not exists pg_stat_statements` and `analyze`), never\nEXPLAIN ANALYZE a write statement, never change query semantics, never open a\nduplicate card.\n\nIf the database is unreachable, record it and stop. If nothing is slow, say so\nand exit — a quiet run is a successful run.",
        },
      ],
      connectors: [
        {
          slug: 'postgres',
          provider: 'composio',
          app: 'postgres',
          name: 'PostgreSQL (Supabase / Neon / RDS)',
        },
        {
          slug: 'github',
          provider: 'composio',
          app: 'github',
          name: 'GitHub',
        },
        {
          slug: 'linear',
          provider: 'composio',
          app: 'linear',
          name: 'Linear',
        },
      ],
      agents: {
        'slow-query-optimizer': {
          connectors: ['postgres', 'github', 'linear'],
          secrets: [
            'GITHUB_REPO',
            'SLOW_QUERY_LIMIT',
            'MIN_MEAN_MS',
            'MIN_TOTAL_MS',
            'MAX_CARDS_PER_RUN',
            'POSTGRES_CONNECTION_STRING',
            'GITHUB_PAT',
            'LINEAR_API_KEY',
          ],
          kortix_cli: ['project.read'],
          skills: 'all',
        },
      },
    },
  },
  {
    slug: 'kortix-feedback-triage',
    title: 'Feedback Triage',
    description:
      'Scheduled agent that sweeps new customer feedback across Intercom, Zendesk, Canny, ProductBoard, and G2, classifies each item, posts an internal triage note, and opens a GitHub or Linear ticket for everything that needs action. Never replies to customers, never assigns, never closes.',
    repo: 'DimitrijeGlibic/kortix-feedback-triage',
    repo_owner: 'DimitrijeGlibic',
    repo_name: 'kortix-feedback-triage',
    git_ref: null,
    resolved_sha: 'ecbcf8df3fdbc9a38e1a2ddb22d77cd5f1432fe8',
    agents: [
      {
        name: 'feedback-triage',
        description: null,
      },
    ],
    triggers: [
      {
        slug: 'hourly-sweep',
        name: 'Hourly feedback sweep',
        type: 'cron',
        cron: '0 0 * * * *',
        agent: 'feedback-triage',
        enabled: true,
      },
    ],
    connectors: [
      {
        slug: 'canny',
        provider: 'composio',
        app: 'canny',
      },
      {
        slug: 'g2',
        provider: 'composio',
        app: 'g2',
      },
      {
        slug: 'github',
        provider: 'composio',
        app: 'github',
      },
      {
        slug: 'intercom',
        provider: 'composio',
        app: 'intercom',
      },
      {
        slug: 'linear',
        provider: 'composio',
        app: 'linear',
      },
      {
        slug: 'productboard',
        provider: 'composio',
        app: 'productboard',
      },
      {
        slug: 'zendesk',
        provider: 'composio',
        app: 'zendesk',
      },
    ],
    skills: [],
    env_required: ['TICKET_TARGET'],
    manifest: {
      kortix_version: 2,
      default_agent: 'feedback-triage',
      project: {
        name: 'Feedback Triage',
        description:
          'Scheduled agent that sweeps new customer feedback across Intercom, Zendesk, Canny, ProductBoard, and G2, classifies each item, posts an internal triage note, and opens a GitHub or Linear ticket for everything that needs action. Never replies to customers, never assigns, never closes.',
      },
      env: {
        required: ['TICKET_TARGET'],
        optional: [
          'GITHUB_REPO',
          'LINEAR_TEAM',
          'MAX_TICKETS_PER_RUN',
          'TRIAGE_NOTE',
          'FEEDBACK_WINDOW_HOURS',
        ],
      },
      opencode: {
        config_dir: '.kortix/opencode',
      },
      triggers: [
        {
          slug: 'hourly-sweep',
          name: 'Hourly feedback sweep',
          type: 'cron',
          agent: 'feedback-triage',
          enabled: true,
          cron: '0 0 * * * *',
          timezone: 'UTC',
          prompt:
            'Run one feedback triage sweep.\n\nLoad the `triage-rubric` skill, read `state/triage-state.json`, then follow\nyour agent instructions end to end: inventory the connected feedback sources,\npull new feedback from each, classify every item with the rubric, dedupe\nagainst existing tickets (footer `feedback-triage: <source>/<external-id>:`,\npost internal triage notes where supported, open tickets for bugs, feature\nrequests, and high-severity complaints in `TICKET_TARGET`, write state back,\nand end with a run summary.\n\nInternal notes only — never reply to a customer. Never assign, never close,\nnever exceed MAX_TICKETS_PER_RUN. If there is no new feedback, say so and\nexit; a quiet sweep is a successful sweep.',
        },
      ],
      connectors: [
        {
          slug: 'intercom',
          provider: 'composio',
          app: 'intercom',
          name: 'Intercom',
        },
        {
          slug: 'zendesk',
          provider: 'composio',
          app: 'zendesk',
          name: 'Zendesk',
        },
        {
          slug: 'canny',
          provider: 'composio',
          app: 'canny',
          name: 'Canny',
        },
        {
          slug: 'productboard',
          provider: 'composio',
          app: 'productboard',
          name: 'ProductBoard',
        },
        {
          slug: 'g2',
          provider: 'composio',
          app: 'g2',
          name: 'G2',
        },
        {
          slug: 'github',
          provider: 'composio',
          app: 'github',
          name: 'GitHub',
        },
        {
          slug: 'linear',
          provider: 'composio',
          app: 'linear',
          name: 'Linear',
        },
      ],
      agents: {
        'feedback-triage': {
          connectors: ['intercom', 'zendesk', 'canny', 'productboard', 'g2', 'github', 'linear'],
          secrets: [
            'TICKET_TARGET',
            'GITHUB_REPO',
            'LINEAR_TEAM',
            'MAX_TICKETS_PER_RUN',
            'TRIAGE_NOTE',
            'FEEDBACK_WINDOW_HOURS',
          ],
          kortix_cli: ['project.read'],
          skills: 'all',
        },
      },
    },
  },
  {
    slug: 'ads-ab-testing-lab',
    title: 'Ads A/B Testing Lab',
    description:
      'Daily, autonomous A/B testing for paid ads. Pulls results from Meta Ads, Google Ads, or any ad platform with an API, checks statistical significance against pre-registered sample sizes, declares winners only when the evidence is there, learns from every concluded test, and continuously designs the next experiment to push the goal metric up.',
    repo: 'DimitrijeGlibic/ads-ab-testing-lab',
    repo_owner: 'DimitrijeGlibic',
    repo_name: 'ads-ab-testing-lab',
    git_ref: null,
    resolved_sha: '607f9ad7d369d85c20295e3afc7212bb29343d8b',
    agents: [
      {
        name: 'harness-reflector',
        description: null,
      },
      {
        name: 'kortix',
        description: null,
      },
    ],
    triggers: [
      {
        slug: 'daily-ab-run',
        name: 'Daily A/B run',
        type: 'cron',
        cron: '0 0 9 * * *',
        agent: 'kortix',
        enabled: true,
      },
      {
        slug: 'launch-approved',
        name: 'Launch approved tests',
        type: 'webhook',
        cron: null,
        agent: 'kortix',
        enabled: true,
      },
    ],
    connectors: [
      {
        slug: 'google-ads',
        provider: 'http',
        app: null,
      },
      {
        slug: 'meta-ads',
        provider: 'http',
        app: null,
      },
    ],
    skills: [],
    env_required: ['ADS_LAB_LAUNCH_SECRET'],
    manifest: {
      kortix_version: 2,
      default_agent: 'kortix',
      project: {
        name: 'Ads A/B Testing Lab',
        description:
          'Daily, autonomous A/B testing for paid ads. Pulls results from Meta Ads, Google Ads, or any ad platform with an API, checks statistical significance against pre-registered sample sizes, declares winners only when the evidence is there, learns from every concluded test, and continuously designs the next experiment to push the goal metric up.',
      },
      env: {
        required: ['ADS_LAB_LAUNCH_SECRET'],
        optional: [
          'META_ACCESS_TOKEN',
          'META_AD_ACCOUNT_ID',
          'GOOGLE_ADS_CUSTOMER_ID',
          'GOOGLE_ADS_DEVELOPER_TOKEN',
          'GOOGLE_ADS_SERVICE_ACCOUNT_JSON',
          'EXECUTE_MODE',
          'ADS_LAB_DAILY_CAP_USD',
          'SLACK_CHANNEL_ID',
        ],
      },
      agents: {
        kortix: {
          connectors: 'all',
          secrets: 'all',
          kortix_cli: 'all',
          skills: 'all',
        },
        'harness-reflector': {
          kortix_cli: 'all',
          skills: 'all',
        },
      },
      connectors: [
        {
          slug: 'meta-ads',
          name: 'Meta Ads API',
          provider: 'http',
          base_url: 'https://graph.facebook.com',
        },
        {
          slug: 'google-ads',
          name: 'Google Ads API',
          provider: 'http',
          base_url: 'https://googleads.googleapis.com',
        },
      ],
      triggers: [
        {
          slug: 'daily-ab-run',
          name: 'Daily A/B run',
          type: 'cron',
          agent: 'kortix',
          enabled: true,
          cron: '0 0 9 * * *',
          timezone: 'UTC',
          session_mode: 'fresh',
          prompt:
            "Load the `ads-ab-lab` skill and run the **daily loop** for the window that closed at the previous fire ({{ cron.last_scheduled_for }}; on a manual fire, the last 24h). RUN=$(date -u +%Y-%m-%d).\n\nThe skill is the procedure: statistics rules, platform references, and the hypothesis bank. Follow its order exactly — safety preconditions, fetch, evaluate, archive, learn, plan, report, CR. Never declare a winner the significance engine did not certify. Never spend outside the budget caps in config/ads-lab.json. In `propose` mode (default) a new test only gets *planned* today and *drafted* into the run's change request — it is not launched until the launch-approved webhook fires.\n\nEnd by opening a change request (`kortix cr open`) carrying the state updates, the run summary, and any proposed test, then report the CR number and the headline verdicts in one short block.",
        },
        {
          slug: 'launch-approved',
          name: 'Launch approved tests',
          type: 'webhook',
          agent: 'kortix',
          enabled: true,
          secret_env: 'ADS_LAB_LAUNCH_SECRET',
          prompt:
            'Load the `ads-ab-lab` skill. The human has approved launching the proposed test(s) from daily run {{ body.run_id }} (CR #{{ body.cr_number }} if given).\n\nVerify before doing anything: the run directory runs/{{ body.run_id }} exists, its queue.json lists test(s) with status `proposed`, the CR exists (kortix cr show {{ body.cr_number }} when provided) and is merged, and the spend still fits config/ads-lab.json budget caps plus the ADS_LAB_DAILY_CAP_USD override. Refuse if {{ body.approve }} is not true, or if any of the caps would be exceeded.\n\nThen launch exactly the listed tests on the target platform (references/meta-ads.md or google-ads.md — agent calls the connector, adapters print the exact payloads), set their state to `running` in state/tests.json, and report back the platform experiment ids plus the spend committed.',
        },
      ],
    },
  },
  {
    slug: 'kortix-competitor-watch',
    title: 'Competitor Watch',
    description:
      'Daily market-intel agent: crawls competitor pricing pages, changelogs, and job feeds, diffs them against the last run, flags meaningful moves (new pricing tier, feature launch, hiring surge in a specific area), summarizes the implication, and posts a digest to Slack or appends a dated entry to a Notion doc. Reads public pages only; never acts beyond posting.',
    repo: 'DimitrijeGlibic/kortix-competitor-watch',
    repo_owner: 'DimitrijeGlibic',
    repo_name: 'kortix-competitor-watch',
    git_ref: null,
    resolved_sha: 'bf1070e91d51a873dcc858326d18e242f0130d95',
    agents: [
      {
        name: 'competitor-watch',
        description: null,
      },
    ],
    triggers: [
      {
        slug: 'daily-market-sweep',
        name: 'Daily market sweep',
        type: 'cron',
        cron: '0 0 7 * * *',
        agent: 'competitor-watch',
        enabled: true,
      },
    ],
    connectors: [
      {
        slug: 'notion',
        provider: 'composio',
        app: 'notion',
      },
      {
        slug: 'slack',
        provider: 'composio',
        app: 'slack',
      },
    ],
    skills: [],
    env_required: [],
    manifest: {
      kortix_version: 2,
      default_agent: 'competitor-watch',
      project: {
        name: 'Competitor Watch',
        description:
          'Daily market-intel agent: crawls competitor pricing pages, changelogs, and job feeds, diffs them against the last run, flags meaningful moves (new pricing tier, feature launch, hiring surge in a specific area), summarizes the implication, and posts a digest to Slack or appends a dated entry to a Notion doc. Reads public pages only; never acts beyond posting.',
      },
      env: {
        required: [],
        optional: ['SLACK_CHANNEL', 'NOTION_DOC_ID'],
      },
      opencode: {
        config_dir: '.kortix/opencode',
      },
      triggers: [
        {
          slug: 'daily-market-sweep',
          name: 'Daily market sweep',
          type: 'cron',
          agent: 'competitor-watch',
          enabled: true,
          cron: '0 0 7 * * *',
          timezone: 'UTC',
          prompt:
            "Run one daily market sweep.\n\nLoad the `market-intel-rules` skill, read `state/competitor-snapshot.json`, then follow your agent instructions end to end: fetch every watched source (pricing pages, changelog and job feeds) from the public web, normalize and diff against the last snapshot, filter cosmetic edits, apply the hiring-surge rule per area, classify meaningful changes (new pricing tier, feature launch, messaging rewrite) with implications labeled `(inference)`, post the digest to SLACK_CHANNEL and/or append it to NOTION_DOC_ID, and write state back.\n\nRead-only against the outside world. Never fetch behind a login wall, never act on a competitor's site, never touch internal systems, never fabricate a change. If nothing changed, say so in one line and exit — a quiet sweep is a successful sweep.",
        },
      ],
      connectors: [
        {
          slug: 'slack',
          provider: 'composio',
          app: 'slack',
          name: 'Slack',
        },
        {
          slug: 'notion',
          provider: 'composio',
          app: 'notion',
          name: 'Notion',
        },
      ],
      agents: {
        'competitor-watch': {
          connectors: ['slack', 'notion'],
          secrets: ['SLACK_CHANNEL', 'NOTION_DOC_ID'],
          kortix_cli: ['project.read'],
          skills: 'all',
        },
      },
    },
  },
];

function toCard(entry: MarketplaceCatalogEntry): MarketplaceTemplate {
  const { manifest: _manifest, ...card } = entry;
  return card;
}

/**
 * The catalog, optionally narrowed by a free-text `q` over title, description,
 * repo and slug. Returns cards only — the manifest travels to the agent through
 * the install prompt, never to a browser.
 */
export function listMarketplaceTemplates(q?: string | null): MarketplaceTemplate[] {
  const needle = q?.trim().toLowerCase() ?? '';
  return MARKETPLACE_CATALOG.filter(
    (entry) =>
      !needle ||
      [entry.title, entry.description ?? '', entry.repo, entry.slug].some((field) =>
        field.toLowerCase().includes(needle),
      ),
  ).map(toCard);
}

/** One card by slug, or null. */
export function getMarketplaceTemplate(slug: string): MarketplaceTemplate | null {
  const entry = findMarketplaceCatalogEntry(slug);
  return entry ? toCard(entry) : null;
}

/** One full entry by slug — the install route's read. */
export function findMarketplaceCatalogEntry(slug: string): MarketplaceCatalogEntry | null {
  return MARKETPLACE_CATALOG.find((entry) => entry.slug === slug) ?? null;
}
