# Claims

What Kortix may say about itself, in what words, and what it must never say. Read this before you
write a proof point, a security line, a comparison, a number, a store listing, a deck slide or a
sales email. This file is the single home of the accuracy gates that 20 marketing source files
carried as separate `ACCURACY GATE` comments, and of the standing traps in `kortix-presentation`.

Rule format: **Rule.** — *Why:* — *Where:* — *When silent:*. Tables list facts.

Last verified: 2026-10-01 against the worktree at `origin/main` `d7efef858f` unless a row says
otherwise. Re-verify a row before you reuse it in a new launch.

## 1. How to use this file

**Rule.** Make every claim trace to a row in section 2 or section 4, and use the exact words in the row. — *Why:* Marketing copy drifted from code in 40 source files. Each gate is a correction a security reviewer or a customer found. — *Where:* every surface. — *When silent:* do not make the claim. Write the narrower claim that the code proves, or ask.

**Rule.** Use a row's sentence word for word, qualifiers included ("today", "per project", "plain files today"). Shorten by deletion only. Never merge two rows into one new sentence, and never drop a qualifier. — *Why:* runs merged "Roles, groups" and "audit trail" rows into a new sentence, dropped "today" from the memory row, and wrote "an agent is a markdown file" without its `kortix.yaml` block. Each is a claim no row makes (Q36). — *Where:* every surface. — *When silent:* the row's own sentence, or no claim.

**Rule.** Import marketing copy from `apps/web/src/features/marketing/*/content.ts`. Never retype it into a deck, an email or a store listing. — *Why:* A retyped claim keeps saying the old thing after the product stops doing it (kortix-presentation, "Copy accuracy"). — *Where:* deck | email | store listing. — *When silent:* link to the page instead of copying the sentence.

**Rule.** When code and a doc disagree, the code wins and you open an issue for the doc. — *Why:* Docs go stale. The secrets page and the registry disagreed on 2026-10-01 (section 5). — *Where:* every surface. — *When silent:* cite the file and line you read.

## 2. Sanctioned proof points

Use these words. Do not invent others.

| Claim | Exact words | Source | Verified |
| --- | --- | --- | --- |
| Source | Open source. Read it, fork it, audit it. | README.md "How it compares" | 2026-10-01 |
| Stars | 20,000+ GitHub stars on `kortix-ai/suna`. | `gh api repos/kortix-ai/suna` returned 20,239 | 2026-10-01 |
| Connectors | 3,000+ apps in a click, plus MCP, OpenAPI, Postman, GraphQL and raw HTTP. | `apps/web/src/features/marketing/connectors/content.ts:43,63,70` | 2026-10-01 |
| Connector credentials | Connector credentials are brokered server-side and never enter the machine. | `connectors/content.ts` gate; `apps/api/src/projects/secrets.ts` | gate cited 2026-07-31 |
| One sandbox per session | One isolated sandbox per session. Each session has its own isolated machine and branch. | `security-page/content.ts` (UNIQUE constraint) | gate cited 2026-07-31 |
| Agents edit themselves | An agent can edit its own configuration on its session branch and propose the change. A person approves it. | `concepts.md` section 2, beat 5. The code path was not re-read for this row. Re-verify before a launch. | carried over, 2026-10-01 |
| Parallel work | Thousands of agents in parallel on one config, each on its own cloud computer. | founder-approved proof point, carried over from the pre-kit copy | carried over |
| Path to `main` | Session work reaches `main` through a change request. Merge is default-deny for agents. | `apps/api/src/projects/routes/change-request-actions.ts:61-101` | 2026-10-01 |
| Permissions | Per-resource permissions for people and agents. Roles, groups, and an audit trail. | `apps/web/content/docs/accounts.mdx` | 2026-10-01 |
| SSO | SAML 2.0 single sign-on and SCIM 2.0. | `security-page/content.ts` gate item 7; `accounts.mdx:92` | 2026-10-01 |
| Approval gates | Approval gates you set. Off until you set them. | `apps/web/content/docs/project/manifest.mdx:123` (`policy.default_mode` defaults to `allow_all`) | 2026-10-01 |
| Audit | Every action is recorded. Reading, exporting and streaming the audit log depend on the plan. | `faq/content.ts` gate (`auditAccess`, `apps/api/src/types.ts:129-135`) | gate cited 2026-07-31 |
| Secrets, encrypted | Secrets are encrypted at rest with a key per project. | `security-page/content.ts` specs row | gate cited 2026-07-31 |
| Models | Any model provider with your own keys. Or the ChatGPT plan you already pay for. Or sign in with your OpenCode Console account for OpenCode Zen and Go. | `apps/web/content/docs/project/models.mdx:43,57-71`; `apps/api/src/llm-gateway/credentials/opencode-console.ts:1-19` | 2026-10-01 |
| Channels | Slack and Microsoft Teams are live. Email is experimental, per project. | section 5, item 2 | 2026-10-01 |
| Hosting | Run it on Kortix Cloud, in your VPC, or on your own on-prem network. Self-host is free. | README.md; `self-hosted/content.ts` | 2026-10-01 |
| Price | Free is $0 with 200 credits per month and 1 project. The team plan is $40 per seat per month with 2,500 credits per month per seat, pooled. | `apps/web/src/features/billing/pricing-plans.ts:36-59` | 2026-10-01 |
| Compliance | SOC 2 Type I is held (the report has landed). SOC 2 Type II is in progress. GDPR is a posture Kortix runs, not a certificate. | `security-page/content.ts:16-17,406-407` | 2026-10-01 |
| Ways work runs | On demand, human-assisted, automated. | `concepts.md` section 3 | carried over |
| Harness | OpenCode is the harness. | `how-it-work/how-it-works-content.ts` gate | gate cited 2026-07-31 |

**Rule.** Write the SOC 2 claim as two facts: "SOC 2 Type I is held" and "SOC 2 Type II is in progress". — *Why:* The landing and security gates say a badge for Type II without a landed report is a copy bug. The pre-kit copy said "never claim a certification" without recording that Type I is held. — *Where:* marketing | deck | email | sales. — *When silent:* never write "compliant", "certified" or "we are SOC 2" without the Type. Write no ISO or HIPAA claim: Kortix holds neither.

**Rule.** State the star count as "20,000+", read live where the page can, and claim no other repo metric. — *Why:* The open-source section reads the count from `/api/github-stars`. Forks, contributors and downloads are not read anywhere. — *Where:* marketing | social | deck. — *When silent:* omit the number.

## 3. Never claim

Each rule below is a correction the code forced. The *Why* cites the source.

### Secrets

**Rule.** Do not write that a granted secret is "never visible to the model", "the key never sits in the sandbox", "agents never touch your keys" or "zero exposed secrets". — *Why:* A runtime secret is a real environment value in the session. Any command the agent runs can read it. Only connector credentials and Kortix's own upstream keys never enter the machine (`security-page/content.ts` correction 1; `/enterprise` shipped the false line). — *Where:* marketing | deck | email | sales | store listing. — *When silent:* write the narrow claim: "Connector credentials never enter the machine."

**Rule.** Write "environment is the default exposure" and "egress-enforced is experimental". — *Why:* A new secret defaults to the `environment` exposure (`apps/web/content/docs/project/secrets.mdx:42-50`; `kortix secrets --help`). Egress enforcement is a per-secret option under the experimental `secrets_egress` flag. The pre-kit copy said egress-enforced was the default. — *Where:* docs | marketing | deck | CLI. — *When silent:* do not call any exposure "the safe default".

**Rule.** For an egress-enforced secret, say: "The sandbox holds a handle. Kortix substitutes the real value outside the sandbox, only on approved HTTPS hosts. An echoed value comes back as `[REDACTED]`." — *Why:* That is the mechanism (`kortix secrets --help`). It is one mechanism on every sandbox provider. — *Where:* docs | marketing | deck. — *When silent:* never present "network boundary" and "HTTPS broker" as two choices.

**Rule.** For a computed credential (AWS SigV4, HMAC webhook signing, JWT assertions, SSH or PEM keys) or a non-HTTPS protocol, say it must stay on `environment`. — *Why:* The code must hold the value to compute with it. No network boundary helps. — *Where:* docs | CLI. — *When silent:* name the exposure and say who can read the value.

**Rule.** Say "Who can use it" for a secret's audience, with three choices: everyone in the project (default), only you, specific people or groups. — *Why:* `secrets.mdx` "Who can use a secret" documents it (PR #8533, 2026-10-01). The sentence "scoped per person or per group is retired" was true of the old model (migration `20260706_secrets_v2_identifier_model.sql`) and is now wrong in the other direction: the audience exists. — *Where:* docs | marketing | web | CLI (`kortix secrets share`). — *When silent:* state the delivery rule with the audience: shared sessions, triggers, schedules and webhooks act for nobody, so they get only values shared with everyone.

**Rule.** Do not say a secret is "scoped per person" as the delivery model. Say a session receives a secret only when the person who started it, and the agent's grant, both allow it. — *Why:* Delivery is the intersection of the audience and the agent grant. A narrowed value already delivered as an environment variable stays in that sandbox until the next push. — *Where:* docs | marketing. — *When silent:* if the value may have been read, say "rotate it".

### Isolation and network

**Rule.** Do not write blanket "microVM isolation". Write "its own isolated machine", and name the provider when the boundary matters. — *Why:* Platinum is a Cloud Hypervisor microVM. The default provider, Daytona (`ALLOWED_SANDBOX_PROVIDERS` defaults to `daytona`, `apps/api/src/config.ts:695`), is not. The always-on monitor box is a persistent microVM (`apps/web/content/docs/connect/triggers.mdx:104`). — *Where:* marketing | deck | sales | docs. — *When silent:* "sandbox" or "cloud computer".

**Rule.** Do not write "container" in external copy. — *Why:* The sanctioned nouns are "cloud computer" and "sandbox". "Container" reads as shared-kernel and invites the isolation question. — *Where:* marketing | deck | store listing. — *When silent:* "sandbox".

**Rule.** Do not claim that Kortix controls, blocks or allow-lists a sandbox's outbound traffic. Do not write "egress controlled at the network", "permissions to the network level" or "network-level patterns". — *Why:* Nothing implements it. E2B ships `allowInternetAccess: true`. The network-policy design is not scheduled. What exists is egress-enforced secrets: a different claim about where a credential may go. — *Where:* every surface. — *When silent:* "The credential is enforced at the network boundary", never "the network is locked down". For rules on a connector call, write "rules down to the arguments of each call".

**Rule.** Do not write "air-gapped". — *Why:* `kortix self-host start` pulls images from docker.io. The default sandbox provider is remote. The instance must be reachable so the sandbox can call back (`self-hosted/content.ts` gate item 4). — *Where:* marketing | sales | docs. — *When silent:* "On-prem. We scope isolated topologies with you." Route to Enterprise.

### Computers

**OPEN (Q20).** No row states how a person connects their own computer: no command, no operating-system list, no scope of what the agent can reach on it. Do not write a mechanism line in a launch email until a person verifies one against code and adds a row here. — *When silent:* name only what the vocabulary row says ("a person's own machine connected to Kortix") and list the gap under Guesses.

### Merge, approval, autonomy

**Rule.** Write that merge is default-deny for agents. Do not write "only a human can merge". — *Why:* An admin can grant `project.gitops.merge`. Today that is the capability name. `project.cr.merge` is the retired spelling and still resolves (`apps/web/content/docs/work/change-requests.mdx:120-130`; `change-request-actions.ts:73`). The pre-kit copy of this fact and `kortix-presentation` still name `project.cr.merge`. A session can never merge a change request it opened itself. — *Where:* every surface. — *When silent:* "Nothing merges itself: work reaches `main` through a change request a person approves, unless an admin granted the merge capability." Write `project.gitops.merge` in anything new.

**Rule.** Write that approval gates are off until you set them. Do not write "gates are on", "it asks first" or "writes require approval by default". — *Why:* `policy.default_mode` falls back to `allow_all` (`manifest.mdx:123`). — *Where:* every surface. — *When silent:* "You set allow, ask or block." Write the key nested in a YAML excerpt (`policy:` then `default_mode:` under it, a top-level key per `manifest.mdx`). The dotted form is a docs path, not YAML (Q36).

**Rule.** Do not write "fully autonomous company", "the agent deploys", "pushes to main" or "self-driving". — *Why:* Work lands through a change request. Config edits from the dashboard can commit straight to the default branch, so scope "reaches `main` only through a change request" to session work (`how-it-works-content.ts` gate). — *Where:* every surface. — *When silent:* "opens a change request you approve".

### Scale, speed, metrics

**Rule.** Write "thousands of agents in parallel". Do not write "hundreds of thousands", "unlimited" or "scale without limits". — *Why:* "Thousands" is the sanctioned proof point. `/enterprise` shipped "hundreds of thousands" (`apps/web/translations/en.json:3373`). — *Where:* marketing | sales. — *When silent:* "thousands".

**Rule.** Quote no latency, uptime, benchmark, productivity metric or customer count. — *Why:* None is measured for public use. — *Where:* every surface. — *When silent:* "3,000+ apps" is the only sanctioned number on the agent-computer page. The star count is the only sanctioned metric about Kortix.

**Rule.** Never name a customer, a customer's people or a customer's data in any copy, image, deck or commit. Use a codename or the class ("a customer", "an enterprise workspace"). — *Why:* the repo rule in `CLAUDE.md` forbids customer data in anything published, and the pre-kit copy carried the same line. — *Where:* every surface. — *When silent:* write the class, not the name.

**Rule.** Do not name a model version number on a marketing page. Name model families. — *Why:* A page naming `opus-4.7` is wrong within the month, and no build step catches it (`step-models.tsx` gate). — *Where:* marketing | deck. — *When silent:* "any model, your keys".

### Models and subscriptions

**Rule.** Name ChatGPT and the OpenCode Console as the subscription sign-ins. Do not name Claude or Cursor as a subscription you can bring. — *Why:* ChatGPT is real (Codex device-grant OAuth, `apps/api/src/projects/codex-device-auth.ts`). OpenCode Zen and Go sign-in is real (`opencode-console.ts`; `kortix providers login opencode-go`, `kortix providers login opencode`). No Claude or Cursor subscription path exists in code. The pre-kit copy said "Only ChatGPT is wired"; that is stale. — *Where:* marketing | docs | deck | sales. — *When silent:* "any provider, your own keys".

**Rule.** Name no third-party harness other than OpenCode. — *Why:* OpenCode is the only shipped harness. ACP and the Claude Code, Codex and Pi harnesses are behind `KORTIX_ACP_RUNTIME` (default false). A careers line about candidate fluency in other tools must never read as Kortix support. — *Where:* marketing | docs | careers. — *When silent:* "OpenCode".

**Rule.** Name a managed model lineup only from open-weight models. Never present OpenAI or Anthropic models as Kortix-managed. — *Why:* Standing founder decision from 2026-09. No code file states it; `decisions.md` records it so the rule has a home. — *Where:* marketing | docs | deck | pricing. — *When silent:* "any model, your keys".

### Identity and SSO

**Rule.** Write "SAML 2.0" for enterprise SSO. Never write "SAML/OIDC" or "OIDC SSO". — *Why:* the only enterprise SSO is SAML 2.0 (`apps/web/content/docs/accounts.mdx:92`; `security-page/content.ts` gate item 7). Verified 2026-10-01: `grep -il oidc apps/web/content/docs` matches only `sdk/sign-in.mdx`, where `email` is "an alias for OIDC-shaped clients". That is a claim shape, not an SSO feature. — *Where:* marketing | sales | docs | deck. — *When silent:* "SAML 2.0 single sign-on and SCIM 2.0".

### Channels

**Rule.** Write that a channel is Slack, Microsoft Teams or email, a closed set of three. Do not list Telegram, WhatsApp, SMS, Discord or voice. — *Why:* `CHANNEL_PLATFORMS = ['slack', 'teams', 'email']` (`packages/manifest-schema/src/constants.ts:175`). The pre-kit copy and the channels page listed four and included `voice`. Telegram has an inbound webhook only; the others have no code. — *Where:* every surface. — *When silent:* name Slack only.

**Rule.** Label Slack and Microsoft Teams live. Label email "experimental, per-project flag". — *Why:* The `teams` flag graduated on 2026-10-01: every project can connect Teams, and no route or screen checks a flag (`apps/api/src/feature-flags/registry.ts` has no `teams` entry; `unit-feature-flags.test.ts` "teams graduated"). The managed one-click install needs the Microsoft app credentials on the server; a project can bring its own bot instead. The email channel sits behind `agentmail_email`, Experimental, Off. The `TEAMS_CHANNEL_ENABLED` operator switch is gone. — *Where:* marketing | docs | app. — *When silent:* "Slack and Microsoft Teams".

**Rule.** Do not write bare "one click" for a Slack install. — *Why:* One-click install needs the Slack app credentials on the server. Without them the UI falls back to a paste-your-manifest flow. In both cases the bot must be invited to a channel and @-mentioned. — *Where:* marketing | docs. — *When silent:* write what happens: "Add to Slack, invite the bot, mention it with a task."

**Rule.** Do not write a `channels:` block in any `kortix.yaml` example, and do not say `kortix.yaml` declares channels. — *Why:* Schema version 2 rejects `channels:`. A connected channel is a connector with `provider: channel`. Routing is live project state (`company-as-code/content.ts` gate). — *Where:* marketing | docs | deck. — *When silent:* leave channels out of the YAML.

### Product facts by page

**Rule.** Hold each of these facts when you write the named page or its derivatives. — *Why:* Each came from a gate in a content file. — *Where:* marketing | deck | docs. — *When silent:* leave the sentence out.

| Topic | Fact to hold | Gate source |
| --- | --- | --- |
| Agent | An agent is `agents/<name>.md` (behavior) plus an `agents.<name>` block in `kortix.yaml` (governance). The `.md` is a stock OpenCode agent file. The scoping field is `permission`, not `tools`. Behavior keys in `kortix.yaml` are a hard error. | agents-and-skills, step-harness, step-source-of-truth |
| Frontmatter | `tools:` and `skills:` are not frontmatter keys. Do not show them. | step-harness |
| Triggers | Exactly two types: `cron` and `webhook`. `session_mode` has four values: `fresh`, `reuse`, `pinned`, `keyed`. The default is `fresh`. A trigger has no "post the result to a channel" field. | automations |
| Connector policy | Actions are `always_run`, `require_approval`, `block`, shown as Allow, Ask, Block. Approval holds the call; the agent's turn pauses and resumes. | connectors |
| Audit view | The per-session audit view is an Enterprise entitlement. Never write "full org-wide audit trail". Recording is never gated. | connectors, faq |
| Manifest | `kortix.yaml` declares the machine image, connectors and triggers, and secret names and grants. Secret values never appear in the repo. There is no Members node: members and roles are live project state. | step-source-of-truth, company-as-code |
| Example data | Use placeholders: Acme, Northwind, Globex, Initech, Umbrella, Vandelay. People in sample data are numbers, not names. | solutions/types, company-as-code |
| Sample numbers | A number in a fictional company's sample data is fine. A number that reads as a Kortix metric, ranking or certification is not. | solutions/types |
| Screenshots | Never swap a built artifact for a picture of a product surface that does not exist. | solutions/types |
| Third-party tools | Name a third-party tool only if it is in the connector catalog. | solutions/types |
| Self-host | The first run asks six things and no model key. GitHub connects in the dashboard (Settings → Git). Models are BYOK in the app. Pipedream is optional. The stack has no Redis and no separate worker. Link `/docs/host`. | self-hosted |
| Desktop and mobile | macOS ships one universal `.dmg`. Linux desktop is x86_64 only. No Windows CLI binary: say "macOS and Linux, WSL on Windows". No Chrome extension exists. Neither mobile app is public: show a status, not a store link. State re-verified before each launch. | download (gate dated v0.11.0, 2026-07-28) |
| About page | Training, RL and evals are not shipped. Write them as direction, in the future tense. | about |
| Careers | Invent nothing about employment: no salary band, equity, benefits, headcount or remote policy. The only locations are Belgrade, Serbia and San Francisco. Ask for a link to a CV, never an attachment. No ATS, no jobs alias. | careers |
| Blog | A blog claim is checked against the landing, open-source and how-it-works copy and against this file. | blog-posts gate |

### Words that overclaim

**Rule.** Do not write: more powerful, fully extensible, seamless, revolutionary, unlock productivity, next-gen, AI-powered magic, transformative, the go-to, #1, the best. — *Why:* Banned hype. Each one fails the "what mechanism?" test. — *Where:* every surface. — *When silent:* name the mechanism.

**Rule.** Do not write "fully autonomous cognitive beings", "digital coworkers" or "genius colleague". — *Why:* They claim autonomy that the change request gate contradicts. The careers page still carries one (`careers/content.ts:112`). — *Where:* marketing | store listing. — *When silent:* "agents that do finished work, reviewed by people".

## 4. The claim test

Before you publish any claim, answer five questions. If you answer "no" to any, cut the claim.

1. Does a row in section 2 or a file you read today state it?
2. Is the wording the narrowest true version (connector credentials, not "secrets")?
3. Does it name a provider, plan or flag where the truth depends on one?
4. Does it contain a number that is not in section 2?
5. Would a security reviewer find the sentence in code or in `/security`?

**Rule.** Run the claim test on every sentence that contains a verb of capability, a number, or the words "secure", "isolated", "private", "compliant" or "never". — *Why:* These words carry every correction in this file. — *Where:* every surface. — *When silent:* ask a person who owns the area.

## 5. Corrections to pre-kit facts

History: the pre-kit copy of these facts was stale in the places below. This file replaces it. Each item names the file you read.

1. **Secret exposure default.** Old: egress-enforced is the default. Now: `environment` is the default; egress-enforced is experimental. Read: `apps/web/content/docs/project/secrets.mdx:42-50`, `kortix secrets --help`, `apps/api/src/projects/routes/secret-delivery.ts:182`. Open conflict: `apps/api/src/feature-flags/registry.ts` sets `secrets_egress` `platformDefault: () => true` (comment: "On by default (founder, 2026-09-03). ... a new secret still defaults to an environment variable"). The CLI help and the docs say the flag is off by default. Copy stays safe: say "experimental" and "environment is the default".
2. **Channel enum and the Teams flag.** Old: four values with `voice`, and a `TEAMS_CHANNEL_ENABLED` operator switch; later a per-project experimental `teams` flag. Now: three values; Teams is live for every project (the flag graduated on 2026-10-01). Read: `packages/manifest-schema/src/constants.ts:175`, `apps/api/src/__tests__/unit-feature-flags.test.ts` ("teams graduated"), `apps/web/content/docs/connect/teams.mdx`.
3. **Subscription providers.** Old: only ChatGPT. Now: ChatGPT and sign-in with the OpenCode Console (Zen and Go). Read: `apps/api/src/llm-gateway/credentials/opencode-console.ts:1-19`, `apps/web/content/docs/project/models.mdx:57-71`, `kortix providers login --help`.
4. **Secret audience.** Old: per-person scope retired. Now: the "Who can use it" audience exists for secrets and connector accounts. Read: `apps/web/content/docs/project/secrets.mdx` "Who can use a secret" (PR #8533).
5. **Merge capability name.** Old: `project.cr.merge`. Now: `project.gitops.merge` (the old spelling still resolves). Read: `apps/web/content/docs/work/change-requests.mdx:120-130`, `change-request-actions.ts:73`.
6. **SCIM pagination.** Old: "pages beyond the first are unimplemented". Now: implemented. `listResponse` in `apps/api/src/scim/app.ts:79-90` honors `startIndex` and `count` (max 200) and returns `totalResults`. Verified 2026-10-01. No caveat applies.
7. **Merge grant wording.** Old: "the grant lives in `kortix.yaml` and cannot be widened without an approved change". Dropped. A `kortix.yaml` can list the grant (`change-requests.mdx:128`), but a dashboard config edit can commit straight to the default branch (see the autonomy rule above), so "cannot be widened without an approved change" is false as written. Use the "When silent" line of the merge rule.

**Rule.** Record every future correction here with the file you read and the date. — *Why:* The pre-kit file had no "last verified" date, so a stale fact looked current. — *Where:* every surface. — *When silent:* add a row to `decisions.md` and update this file in the same change.
