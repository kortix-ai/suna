/**
 * Home-page FAQ copy — mounts directly above the closing CTA, after the
 * open-source section.
 *
 * Plain English lives here, not in `apps/web/translations/*.json`, so the copy
 * can iterate before paying the 8-locale parity gate (`pnpm i18n:translations`).
 * Wire i18n keys only once the copy is locked.
 *
 * Voice rules: the `comms` skill.
 *
 * WHY IT EXISTS. Everything above it on the page is an argument. By the time a
 * reader reaches the end they have stopped listening to arguments and started
 * listing objections — what does this actually run on, what stops it doing
 * damage, whose data is it, what does it cost. Answering those in one plain
 * block is worth more than another persuasive section, and it earns the CTA
 * immediately below it: nobody clicks "get started" with an open question.
 *
 * THE ONE RULE THAT MAKES AN FAQ CREDIBLE. Answer the awkward question
 * honestly, and be short. An FAQ that only says flattering things is marketing
 * copy wearing a question mark, and readers know it on sight. The reference case
 * is Claude Cowork's own page, which states outright that Cowork activity is not
 * yet captured in audit logs — that single admission buys more trust than three
 * paragraphs of security prose. Three of the six answers below concede
 * something: gates ship off, self-hosting is not air-gapped, audit READ is an
 * Enterprise entitlement. None of those may be softened. If an edit makes an
 * answer more flattering, it has made the section worthless.
 *
 * SIX, NOT EIGHT OR TEN. Each question is one a reader of THIS page actually
 * arrives with. Nothing was added to reach a round number, and a question that
 * stops being asked should be deleted rather than rewritten.
 *
 * EVERY QUESTION STAYS NEUTRAL. The section renders as a collapsed accordion, so
 * in the resting state a reader sees the six QUESTIONS and none of the answers.
 * That only stays honest while each question is a question. A question rewritten
 * into a claim turns the collapsed list into six pieces of marketing and buries
 * the three concessions completely. Keep them neutral, and keep the
 * unflattering ones visibly present.
 *
 * ==========================================================================
 * ACCURACY GATE — every figure and claim below was read out of code on
 * 2026-07-31. Do not soften, inflate, or "restore" any of it.
 * ==========================================================================
 *  - PRICE. Managed cloud is $40 / seat / mo — `apps/web/src/features/billing/
 *    pricing-plans.ts`, the `team_seat` entry of `PRICING_PLANS` (`price: '$40'`,
 *    `unit: '/ seat / mo'`). Its `free` entry is $0 with "200 credits / month for
 *    sandbox compute" and "1 project". `team_seat` carries "2,500 credits /
 *    month per seat, pooled". (Cited by plan id, not line number — the ids are
 *    stable, the line numbers were not.) Quote no other figure, and never invent
 *    a discount, a trial length or a usage rate.
 *  - MODELS. The ChatGPT subscription path is REAL — Codex device-grant OAuth,
 *    `apps/api/src/projects/codex-device-auth.ts`. There is NO Cursor auth path
 *    and no Claude-subscription auth path anywhere in the codebase, however
 *    often other copy says so (`how-it-works-content.ts:39-41` records the same
 *    correction). Name ChatGPT only.
 *  - SELF-HOST IS NOT AIR-GAPPED. `kortix self-host start` pulls images over the
 *    internet, the default sandbox provider is remote, and the instance must be
 *    reachable so the sandbox can call back (`apps/cli/src/commands/self-host.ts`,
 *    and the honesty gate in `marketing/self-hosted/content.ts`). Say it.
 *  - APPROVAL GATES ARE OFF BY DEFAULT. `policy.default_mode` falls back to
 *    `allow_all` when a project declares no `policy:` block
 *    (`apps/api/src/projects/policies.ts:73`). Write "you set allow, ask or
 *    block", never "it asks first".
 *  - MERGE is default-deny for AGENTS, not human-only. `project.cr.merge` is a
 *    grantable capability (`apps/api/src/projects/routes/r9.ts:58`). Do not
 *    write "only a human can merge".
 *  - SECRETS. Never write that a granted secret is invisible to the model. A
 *    granted RUNTIME secret is a real env value in the session, readable by any
 *    command the agent runs (`docs/ENV_SECRET_EXPOSURE_BASELINE.md`). Only
 *    CONNECTOR credentials never enter the machine (`apps/api/src/projects/
 *    secrets.ts:173,226`).
 *  - AUDIT. Recording is NEVER gated — every tier's actions are always captured.
 *    Only READ, EXPORT and STREAM are entitlement-gated (`auditAccess` in
 *    `apps/api/src/types.ts:129-135`). That distinction is the honest answer and
 *    must survive editing.
 *  - ISOLATION. "Its own isolated machine" only. NEVER a blanket "microVM" —
 *    true for the Platinum provider (Cloud Hypervisor) and not for the default.
 *    Never "container" in external copy. Never claim egress is controlled at the
 *    network; nothing implements it.
 *  - HARNESS. OpenCode only. ACP, `kortix_version: 3` and the Claude Code /
 *    Codex / Pi harnesses sit behind `KORTIX_ACP_RUNTIME` (default false) and
 *    are not shipped. Never name them.
 *  - LICENCE. Say "open source" and stop. Never name one.
 *  - NO CUSTOMER NAMES. NO INVENTED METRICS. The live GitHub star count is the
 *    only sanctioned figure on the site and it belongs to the open-source
 *    section — this one carries no count.
 */

export type FaqItem = {
  /** DOM id of the row, and the test hook. */
  readonly id: string;
  /** The objection, phrased the way a reader would actually put it. */
  readonly question: string;
  /** Two or three sentences. The first one answers; the rest qualify. */
  readonly answer: string;
};

export const faq = {
  eyebrow: 'Straight answers',
  title: 'The questions people ask before the first session.',
  /** One link out, to the page that carries the longest of these answers. */
  /* No trailing link. One 'How Kortix is secured →' under a list of six
     questions pointed at the answer to only one of them, and reads as an
     apology for the section. Each answer carries its own link where it needs
     one. */
  items: [
    {
      id: 'runs-on',
      question: 'What does an agent actually run on?',
      answer:
        'Its own machine. Every session boots an isolated Linux cloud computer with your repo and your tools already on it, on its own git branch — the session id, the sandbox id and the branch name are one and the same string. The agent can install, run and break anything inside it; only what it commits survives, because the machine is destroyed with everything on it.',
    },
    {
      id: 'guardrails',
      question: 'What stops it doing something I did not want?',
      answer:
        'You set allow, ask or block per action, and a rule can match on a glob, a regular expression, or the arguments of the call itself. Be aware that nothing is switched on for you: a project with no policy declared runs every action, so this is a thing you configure rather than a thing you inherit. Session work reaches main through a change request, and merge is default-deny for an agent — an admin has to grant it in kortix.yaml, and that grant is itself an edit somebody else has to merge.',
    },
    {
      id: 'audit',
      question: 'Can I see everything an agent did?',
      answer:
        'It is all recorded, on every plan. Recording is never gated — actions, approvals and the session transcript are captured whatever you pay. Reading, exporting and streaming that audit trail out to your own SIEM is an Enterprise entitlement, so on the lower plans the record exists but the export does not.',
    },
    {
      id: 'ownership',
      question: 'Is my company data yours?',
      answer:
        'No. A project is a git repository — clone it and the agents, the skills and everything the company has learned come with you. Self-host and the database, the files, the repos, the secrets and the audit record all sit on disk you control, on one Docker Compose stack built from the same images the managed cloud runs. It is not air-gapped, and we will not pretend otherwise: agent sandboxes run on the compute provider you configure, and your instance has to be reachable so they can call back.',
    },
    {
      id: 'models',
      question: 'Can I use the models I already pay for?',
      answer:
        'Yes. Bring your own API key for any major provider, or sign in with the ChatGPT subscription you already pay for, or use the managed gateway and bring no key at all. The model is a line of configuration in your repo, so switching provider is a diff rather than a migration.',
    },
    {
      id: 'price',
      question: 'What does it cost?',
      answer:
        'Free is $0 — one project and 200 credits a month of sandbox compute, with your own key for any premium model. Team is $40 per seat per month and pools 2,500 credits a seat. Self-hosting the software costs nothing; you pay your own model bill and your own compute bill instead.',
    },
  ] satisfies readonly FaqItem[],
} as const;
