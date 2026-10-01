# Positioning

What Kortix is, who it is for, what it is against, and which line to use on which surface. Read this
before you write any headline, meta description, store listing, README line, or pitch. For the
words inside the lines, read `voice-and-tone.md`. For what you may claim, read `claims.md`.

Rule format: **Rule.** — *Why:* — *Where:* — *When silent:*.

## 1. The hierarchy: five lines, one job each

| Layer | Line | Use for |
| --- | --- | --- |
| Category | AI Management System | What Kortix is. The default noun everywhere. |
| Tagline | The open-source AI Management System | Page titles, hero, README, CLI banner, GitHub About, auth screen. The default lead. |
| Comparative | The leading open-source alternative to Claude Cowork and ChatGPT Work | Search, social, launch, GitHub. Anchors against the known category. |
| Manifesto line | A company is going to be a git repository | The deep thesis. Manifesto, founder voice, vision talks. Never a page title. |
| Mission | Take a company from human to AGI, and let it keep every byte of itself on the way there. | Founder voice, about, hiring. Never a category. |

**Rule.** Use "AI Management System" as the category and "The open-source AI Management System" as the tagline. — *Why:* D1 (2026-10-01). README, CLI banner, home H1 and the launch film (#8023, 2026-09-29) already use it. The phrase names the job, so a cold reader needs no explanation. — *Where:* app | marketing | mobile | deck | email | CLI. — *When silent:* use the tagline in titles and the category noun in sentences.

**Rule.** Use "command center" only as a descriptor inside a sentence. Never use it as the category, the page title, the meta line, or the tagline. — *Why:* D1. The live site still ships "AI command center" as the title, meta description, manifest name, Slack app, auth tagline and the starter `kortix-system` skill. It competes with the category line. The manifesto uses it as a descriptor ("call it a command center"), and that use stays. — *Where:* marketing | app | email | CLI. — *When silent:* write "AI Management System". If the sentence still needs a descriptor, write "a place to run it from".

**Rule.** Do not write these retired lines: "Autonomous Company Operating System", "open AGI platform", "self-driving companies", "AI Worker", "Super AI Worker", "AI command center" (as category), "genius colleague". — *Why:* D1. Each one either claims a category Kortix does not hold, implies autonomy that a change request gate contradicts, or is legacy Suna copy. — *Where:* every surface, including store listings, permission prompts, email footers and blog posts. — *When silent:* find the closest line in the table above. If none fits, flag it and ask. Do not invent a new category line.

**Rule.** Keep "AI Management System" capitalized as a proper category name. Keep "open-source" hyphenated before a noun and "open source" two words as a noun. — *Why:* One spelling per term. The README and hero use this form. — *Where:* every surface. — *When silent:* "the open-source AI Management System" (adjective); "Kortix is open source" (noun).

**Rule.** Do not name a license in public copy. Write "open source" and stop. — *Why:* The license is a legal detail that changes the claim. Public copy states the fact a reader can verify: they can read, fork and audit the code. — *Where:* marketing | deck | social | email | docs | store listing. — *When silent:* "open source", "code you can read, fork, and audit", "self-host for free". Never add a license badge.

### What-is, in one sentence

Kortix is the open-source AI Management System: your agents, their skills, your company memory, and every connector in one git repo you own, with the agents working on real cloud computers.

### The three lengths

**Rule.** Pick one of three approved lengths. Do not write a fourth. — *Why:* The lengths keep meta text, README and press consistent. The Short line is exactly 129 characters (counted 2026-10-01). — *Where:* marketing | docs | store listing | CLI package descriptions. — *When silent:* choose by the character limit of the field.

- **Short (129 characters, GitHub About, meta description, manifest description, package descriptions):** Open-source AI Management System: your agents, skills, memory, and connectors in one repo you own. Any model. Self-host or cloud.
- **Standard (about 30 words, README subtitle, landing subhead, store subtitle):** Kortix is an open-source AI Management System — your agents, skills, company memory, and connectors in one git repo you own. Any model, your keys, self-hosted or managed cloud.
- **Long (about 70 words, press, docs, about, store description lead):** Agents that deliver finished work are now a product category. Every version of it runs inside a model lab, on that lab's model, with your company's brain on their side of the wall. Kortix is the one you own: an open-source AI Management System where your agents, skills, memory, and connectors live in one git repo, and the agents work on real cloud computers, landing work through a change request a human approves.

### Which line goes on which surface

| Surface | Line | Note |
| --- | --- | --- |
| Page `<title>` and `og:title` (home) | Tagline: "Kortix – The open-source AI Management System" | Brand name once. |
| Page `<title>` (subpage) | "Pricing" (the template adds "| Kortix") | Do not repeat "Kortix" in the page's own title. Today titles read "Kortix pricing \| Kortix". |
| Meta description (home, manifest, Slack app short text) | Short | 129 characters. |
| Meta description (subpage) | One sentence: the mechanism or the offer. 155 characters or fewer. | Not "Current plans and included features." |
| PWA manifest `name` | "Kortix" | `description` = Short. |
| README, GitHub About | Tagline (README) and Short (About) | Already correct. |
| CLI banner and `--help` | Tagline | Already correct. |
| Auth screen subtitle | Tagline | Not "Your AI Command Center". |
| Transactional email footer | "Kortix — The open-source AI Management System" | Shipped since 2026-10-01 (`BRAND_FOOTER`). |
| Slack and Teams app description | Standard, then one sentence on the channel | "Start a session from any Slack thread." |
| Package descriptions (root, CLI, SDK) | Short (root, CLI); "the Kortix API" (SDK) | Not "agent platform". |
| App Store and Play Store listing | Standard, the message house pillars, the three work modes | Commit the store text to the repo (open issue). |
| Docs landing | Meta description: Short. Body lead: Standard | Docs title is "Overview" or "Kortix docs", never "Kortix - Kortix". |
| About page: hero and meta description, `llms.txt` About entry | Mission, word for word (section 3) | The one place the mission is a description. Do not repeat the tagline there (Q41). |

**Rule.** Write each page's meta description as one sentence that names the mechanism or the offer, in 155 characters or fewer. — *Why:* The live home description is 277 characters. `/pricing` and `/enterprise` carry generic lines. A reader and a search crawler both need the concrete thing. — *Where:* marketing | docs. — *When silent:* "{Who} can {do what} with {mechanism}." Example: "Free to start, $40 per seat per month for teams, custom for Enterprise. Any model, your keys."

## 2. What it is, the problem, why now

**What it is.** One place to run an AI-native company. Your agents, skills, connectors, secrets, channels, triggers, and memory live in one repo that is the company: versioned, diffable, owned outright. It feels as simple as a chat app. Underneath, everything is code you own.

**The problem and why now.** See [concepts.md](concepts.md) section 6. Do not restate them here.

**Rule.** Write the mission with "AGI" only in the mission and manifesto, never in a category or product noun. — *Why:* D1 retires "open AGI platform". The mission is founder voice about direction, not a product claim. — *Where:* marketing (about, careers) | deck. — *When silent:* leave "AGI" out of product copy.

## 3. Vision and mission

- **Mission:** Take a company from human to AGI, and let it keep every byte of itself on the way there.
- **Vision:** A company is a git repository: thousands of agents on one config, each isolated, pushing work into a `main` branch that never stops running and keeps improving itself. CI/CD for the work of an organization, not just its code.

**Rule.** Write vision statements in the future tense and shipped capability in the present tense. — *Why:* The about page gate: training, RL and evals are not shipped. A present-tense sentence about an unshipped capability is a copy bug. — *Where:* marketing | deck | press. — *When silent:* if you cannot point at the shipped feature, write "we are building".

## 4. Competitors

Kortix is positioned against the finished-work agent category. A wrong competitor fact costs credibility at once.

| | Claude Cowork | ChatGPT Work |
| --- | --- | --- |
| Vendor | Anthropic | OpenAI |
| Shipped | Desktop January 2026; web and mobile 2026-07-07 | 2026-07-09 |
| Access | Paid plans: Pro, Max, Team, Enterprise | Paid plans, usage-metered |
| Model | Anthropic models only | GPT-5.6 only |
| Hosting | Anthropic's cloud, or the customer's Amazon Bedrock, Google Cloud or Microsoft Foundry account. No self-host. | OpenAI's cloud. No self-host. |

Source: README comparison table (README.md, "How it compares"), publicly documented behavior as of July 2026. Re-check both products before each launch. Cowork facts were verified 2026-07-31 against the vendor's pricing and product pages.

**Rule.** Write "Claude Cowork" (one word, lowercase w) and "ChatGPT Work" (two words, both capitalized). — *Why:* There is no "Claude Work" and no "ChatGPT Cowork". A wrong name is an instant credibility hit. — *Where:* every surface. — *When silent:* copy the name from this table.

**Rule.** Claim only what the vendor documents publicly. Make no claim about their concurrency, parallelism or session limits. — *Why:* Kortix has no verified data. The live Cowork blog post says "one assistant per person" and "your data flows to Anthropic's cloud". Both are unverifiable or wrong. — *Where:* marketing | blog | social | deck. — *When silent:* compare on facts the README table already states: source, models, where it runs, where your configuration lives, access.

**Rule.** Do not write that Cowork is Max-only or Anthropic-cloud-only. — *Why:* Both older claims were wrong. Cowork is included in Pro and Team and runs in the customer's own cloud account. — *Where:* every surface. — *When silent:* write "Closed, no self-host."

**Rule.** Keep every comparison consistent with the README table. Change the README first. — *Why:* One canonical comparison. — *Where:* marketing | social | deck. — *When silent:* link to the README table instead of retyping it.

**Rule.** Use "the leading open-source alternative" and no other superlative. — *Why:* Decided 2026-07-31 and used in the hero. It rests on the star count (20,239 on 2026-10-01, `gh api repos/kortix-ai/suna`). "The best", "#1" and "the go-to" are not allowed. — *Where:* marketing | social | README. — *When silent:* cite the star count, not the adjective. Round down: "20,000+ GitHub stars".

## 5. Audiences and pitches

Each pitch runs: who, pain, promise, mechanism, sanctioned phrases, what not to say.

**Rule.** Write one audience per sentence and use that audience's pitch. — *Why:* A sentence that serves two audiences convinces neither. — *Where:* marketing | deck | social | email. — *When silent:* default to developers for GitHub and docs; companies for the home page; enterprise for `/security` and `/enterprise`.

### Developers (primary)

- **Who:** Engineers who already run coding agents and want them in the cloud, in the background, with state that sticks.
- **Pain:** Agents stuck on one laptop. No shared state, no isolation, no preview per change. Every tool wants its own setup.
- **Promise:** A managed cloud for your coding agents. One `kortix.yaml`, one config, one repo for the state that sticks.
- **Mechanism:** `kortix init`, then `kortix ship`. Every change request gets a preview you can open. Your local agent can spin up cloud sessions and go wide. Bring a subscription you already pay for (ChatGPT today; see `claims.md`).
- **Sanctioned phrases:** "managed cloud for your coding agents", "background agents with a preview per change", "one repo for the state that sticks", "bring your own subscription".
- **Do not say:** "replaces your IDE", "no more code", any claim of autonomous merge without review.

**Rule.** Use this pitch only for developers. — *Why:* developers judge the product by the command they type and the state it keeps. A buyer pitch reads as a sales line to them. — *Where:* marketing (docs, GitHub) | social | README. — *When silent:* lead with the Promise, then one Mechanism item, then stop.

### Companies (primary)

- **Who:** Teams that want AI to do real work across the business, reachable where people already are.
- **Pain:** Work split across many disconnected tools. AI that forgets context. Output that is chat, not finished work. Vendors that hold the data.
- **Promise:** A workforce you can manage. People talk to it through the web, Slack, or the Teams preview. It picks up the business as it goes.
- **Mechanism:** Agents run on real cloud computers and return finished deliverables (decks, reports, code, replies) and take real actions in your tools. Work runs on demand, human-assisted, or automated. The data, the configuration and the model belong to the company.
- **Sanctioned phrases:** "a workforce, not one assistant", "real work, not chat", "run your company from one place you own".
- **Do not say:** "fully autonomous company" (people approve change requests), invented productivity metrics, customer names, "AI worker".

**Rule.** Use this pitch only for company teams. — *Why:* a team buys finished work and reach into its tools. A mechanism list about sandboxes loses it. — *Where:* marketing (home) | deck | email | social. — *When silent:* lead with the Promise, then one Mechanism item, then stop.

### Enterprise (primary)

- **Who:** Security, IT and platform leaders who must put AI in front of a security review.
- **Pain:** AI tools that fold under review: no isolation, no permissions, no audit, no on-prem story.
- **Promise:** Built to survive a security review, not slip past one.
- **Mechanism:** One isolated sandbox per session (say which provider when you name the boundary). Members, groups and roles that match your org. Per-resource permissions for people and agents. A secrets manager. An audit trail. Approval gates that you set (off by default; say so). SAML 2.0 SSO and SCIM. Your own VPC or on-prem network. Not air-gapped: `kortix self-host start` pulls images from docker.io.
- **Sanctioned phrases:** "survives a security review", "isolation, permissions, audit, approval gates", "your data, your models, your infrastructure, no lock-in".
- **Do not say:** "air-gapped", "network-level permissions", "agents never touch your keys", "unbreakable", "100% secure", "hundreds of thousands of agents", a certification Kortix does not hold (see `claims.md`).

**Rule.** Use this pitch only for security, IT and platform reviewers. — *Why:* a reviewer checks each sentence against code and a security page. A claim without a source ends the review (`claims.md`). — *Where:* marketing (`/security`, `/enterprise`) | deck | sales email. — *When silent:* lead with the Promise, then one Mechanism item that `claims.md` sanctions, then stop.

### Agencies and consultancies (secondary)

- **Who:** Firms that bring AI into their clients and need a platform to bet on.
- **Pain:** The same AI plumbing rebuilt per client. No durable platform. Reselling someone else's locked box.
- **Promise:** One horizontal platform, sold through verticalized partners with their own front ends and starter templates.
- **Mechanism:** Partners handle distribution and clients. Kortix provides the technology, the training and the playbook. Importable projects, agents and skills through the marketplace.
- **Sanctioned phrases:** "one horizontal platform, verticalized partners", "the technology, the training, and the playbook".
- **Do not say:** revenue-share or partner terms unless a person gives them as fact.

**Rule.** Use this pitch only for agencies and consultancies. — *Why:* a partner needs the platform fact first. Terms are a person's call. — *Where:* marketing (partners page) | email | deck. — *When silent:* lead with the Promise, then one Mechanism item, then stop.

## 6. Business model (context, not external copy)

Open source and self-hostable underneath. A cloud that charges for seats and compute: Free is $0 with 200 credits per month and 1 project; the team plan is $40 per seat per month with 2,500 credits per month per seat, pooled (`apps/web/src/features/billing/pricing-plans.ts`, verified 2026-10-01). Single-tenant deployments for teams that must self-run. A marketplace of agents, skills and importable projects. Platinum.dev, the compute floor (CPU/GPU sandboxes, inference, training). The platform proves itself by running Kortix's own companies in public.

**Rule.** Quote no price, credit count, discount, trial length or usage rate that is not in `pricing-plans.ts`. — *Why:* A landing line once said $20 and was wrong by 2x. — *Where:* marketing | deck | store listing | email. — *When silent:* link to `/pricing` and state no number.
