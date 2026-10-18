/**
 * The authoritative subprocessor list that the Data Processing Addendum
 * (section 7.2, Annex III) points to. `/legal/subprocessors` renders it, and the
 * API emails it (`billing/services/subprocessor-notices.ts`).
 *
 * A new subprocessor needs 30 days' notice before it processes customer
 * personal data (DPA section 7.3). To add one:
 *
 * 1. Add its row with `noticeDate` set to the day the change reaches prod.
 * 2. Move `SUBPROCESSORS_UPDATED` to that day.
 * 3. From `noticeDate`, prod emails the owners and admins of every paid account,
 *    once. The page shows "From <noticeDate + 30 days>" on the row.
 * 4. Send it no customer data before that date.
 *
 * Changing an existing row (purpose, location) needs no `noticeDate`.
 */

export type Subprocessor = {
  name: string;
  purpose: string;
  location: string;
  /** `YYYY-MM-DD`: the day the 30-day notice starts. Set on a newly added row. */
  noticeDate?: string;
};

export const SUBPROCESSOR_NOTICE_DAYS = 30;

export const SUBPROCESSORS_UPDATED = "2026-10-19";

/** The first day `row` may process customer personal data (`YYYY-MM-DD`), or null for an established row. */
export function subprocessorEffectiveDate(row: Subprocessor): string | null {
  if (!row.noticeDate) return null;
  const date = new Date(`${row.noticeDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + SUBPROCESSOR_NOTICE_DAYS);
  return date.toISOString().slice(0, 10);
}

/** `2026-11-18` → `November 18, 2026`. */
export function formatSubprocessorDate(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export const SUBPROCESSORS_CORE: readonly Subprocessor[] = [
  {
    name: "Amazon Web Services, Inc.",
    purpose:
      "Hosting of the API and gateway, storage, secrets, transactional email (SES), inference for Kortix-managed AI models (Amazon Bedrock)",
    location: "United Kingdom",
  },
  {
    name: "Supabase, Inc.",
    purpose: "Database and authentication",
    location: "United Kingdom",
  },
  {
    name: "Cloudflare, Inc.",
    purpose: "DNS, content delivery, web application firewall",
    location: "Global edge network",
  },
  {
    name: "Vercel Inc.",
    purpose: "Website and web app hosting, web analytics",
    location: "Global edge network; functions in United Kingdom",
  },
  {
    name: "Scaleway SAS",
    purpose: "Servers and storage for agent sandboxes (Kortix Platinum, EU)",
    location: "France, Netherlands, Poland",
  },
  {
    name: "Hivelocity, Inc.",
    purpose: "Servers for agent sandboxes (Kortix Platinum, US)",
    location: "United States",
  },
  {
    name: "PlanetScale, Inc.",
    purpose: "Sandbox control-plane database",
    location: "Germany",
  },
  {
    name: "Daytona Platforms, Inc.",
    purpose: "Secondary agent sandbox provider",
    location: "United States",
  },
  {
    name: "OpenRouter, Inc.",
    purpose: "Routing of requests to Kortix-managed AI models",
    location: "United States",
  },
  {
    name: "CoreWeave, Inc.; Fireworks AI, Inc.; Decart",
    purpose:
      "Inference for Kortix-managed AI models, reached through OpenRouter",
    location: "United States",
  },
  {
    name: "OpenCode Zen; Morph",
    purpose: "Inference for Kortix-managed AI models, reached directly",
    location: "United States",
  },
  {
    name: "Deep Infra, Inc.; Together Computer Inc.; Baseten Labs, Inc.; Parasail; Modal Labs, Inc.; Groq, Inc.; Cerebras Systems Inc.",
    purpose:
      "Inference for Kortix-managed AI models, reached through OpenRouter or directly",
    location: "United States",
    noticeDate: "2026-10-19",
  },
  {
    name: "GitHub, Inc.",
    purpose: "Hosting of Kortix-managed project repositories",
    location: "United States",
  },
  {
    name: "Resend, Inc.; Mailtrap (Railsware)",
    purpose: "Transactional email delivery (fallback providers)",
    location: "United States",
  },
  {
    name: "Better Stack, Inc.",
    purpose: "Application logs and error reporting",
    location: "European Union",
  },
  {
    name: "Langfuse GmbH",
    purpose:
      "AI request metadata (model, tokens, latency); no prompts or outputs",
    location: "European Union",
  },
  {
    name: "PostHog, Inc.",
    purpose: "Product analytics",
    location: "European Union",
  },
  {
    name: "Tavily; Serper; Firecrawl",
    purpose: "Web search and page retrieval when an agent uses these tools",
    location: "United States",
  },
  {
    name: "Plain",
    purpose: "Customer support tickets and replies",
    location: "United Kingdom",
  },
  {
    name: "Stripe, Inc.",
    purpose: "Payment processing and billing",
    location: "United States, European Union",
  },
];

export const SUBPROCESSORS_OPTIONAL: readonly Subprocessor[] = [
  {
    name: "Composio",
    purpose: "Managed connectors to third-party apps, when you connect one",
    location: "United States",
  },
  {
    name: "Pipedream, Inc.",
    purpose:
      "Managed sign-in and actions for third-party apps, when you connect one",
    location: "United States",
  },
  {
    name: "Expo (650 Industries, Inc.)",
    purpose:
      "Push notifications to the Kortix mobile app, when you enable them (title, short message, and a link; no files)",
    location: "United States",
  },
  {
    name: "Slack Technologies, LLC",
    purpose: "Slack channel, when you connect a workspace",
    location: "United States",
  },
  {
    name: "Microsoft Corporation",
    purpose: "Microsoft Teams channel, when you connect a tenant",
    location: "United States",
  },
  {
    name: "AgentMail",
    purpose: "Agent email inboxes, when you enable them",
    location: "United States",
  },
];
