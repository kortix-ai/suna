# Voice and tone

How Kortix sounds, which words it uses, and how the tone changes by surface. Read this before you
write any string: a headline, a button, an error, a toast, an email, a CLI message, a Slack reply,
a doc page, a speaker note, a post. For the lines you may use as positioning, read `positioning.md`.
For what you may claim, read `claims.md`.

Rule format: **Rule.** — *Why:* — *Where:* — *When silent:*. Tables list vocabulary.

Writing style for this file and for all copy follows ASD-STE100 (CLAUDE.md): short sentences, one
idea each, active voice, present tense, one term per concept, no filler.

## 1. Voice

The voice does not change by surface. The tone does (section 5).

**Rule.** Lead with the mechanism and real product proof, not with an abstract AI claim. — *Why:* The product is the proof. "Each session gets its own sandbox and branch" persuades more than "enterprise-grade AI". — *Where:* every surface. — *When silent:* name the noun that does the work: session, repo, sandbox, change request, connector.

**Rule.** Write concrete nouns. Do not write "solutions", "capabilities", "leverage" or "empower". — *Why:* Abstract nouns hide what the product does. — *Where:* every surface. — *When silent:* replace the abstract noun with the object it stands for.

**Rule.** Write one idea per sentence and one audience per sentence. — *Why:* A sentence that serves two readers convinces neither (CLAUDE.md, STE-100). — *Where:* every surface. — *When silent:* split the sentence at the first "and" that joins two ideas.

**Rule.** Be confident, not breathless. Let the product carry the line. — *Why:* The founder bar is "state the fact, not the superlative". — *Where:* every surface. — *When silent:* delete the adjective. If the sentence still works, keep it deleted.

**Rule.** Name no customer. Use a codename or a placeholder (Acme, Northwind, Globex). — *Why:* CLAUDE.md hard rule: no customer data in anything published. A guard (`scripts/check-blocked-terms.sh`) blocks it in commits. — *Where:* every surface, including examples in this kit. — *When silent:* write "a customer" or "a team".

**Rule.** Write "you" for the reader and "we" for the team. Write "Kortix" in the third person for the product in UI chrome. — *Why:* The product speaks as "I" only where an agent talks (section 2). — *Where:* app | marketing | docs | email. — *When silent:* "Kortix saves the secret", not "We saved your secret".

## 2. The agent persona

The in-product agent speaks as "I'm Kortix" in the first chat (`apps/web/translations/en.json:2835-2843`: "Welcome, {name}. I'm Kortix." / "Bring me anything: a task, a workflow, or a half-formed idea. We'll figure it out together." / "Where do you want to start?").

**Rule.** Take the sentence length of the first-chat greeting as the model. Do not copy its closing line, "We'll figure it out together". — *Why:* in this kit "we" is the team (section 1), and the closing line is filler after a question. — *Where:* app. — *When silent:* end the greeting on the question.

**Rule.** Use first person singular ("I", "me") only where the agent itself speaks: the first-chat greeting, replies in a session, and replies in Slack or Teams. — *Why:* The agent is the speaker there. UI chrome around it is the product, not the agent. — *Where:* app | Slack | Teams. — *When silent:* write the product in the third person.

**Rule.** Write agent speech as short, plain, specific sentences with no filler opener. Do not open with "Sure!", "Great question" or "Certainly". — *Why:* Filler costs a line and says nothing. The first-chat strings are one idea per sentence. — *Where:* app | Slack | Teams. — *When silent:* start with the answer or the next step.

**Rule.** The agent never claims a capability the session lacks. — *Why:* An agent that promises a connector it does not have creates a failed turn and a support ticket. — *Where:* app | Slack | Teams. — *When silent:* say what is missing and how to add it ("Connect Gmail to this project, then ask again.").

## 3. Vocabulary

### Brand names

| Write | Never | Note |
| --- | --- | --- |
| Kortix | KORTIX, kortix (in prose) | The company and the platform. Lead with it. `kortix` is the CLI command in mono. |
| Suna | — | The open-source repo (`kortix-ai/suna`). In outward copy, write Kortix unless you mean the repo. |
| Kortix Cloud | Kortix cloud | The managed hosting. Capitalize both words. |
| Platinum.dev | Platinum.Dev | The compute floor. Lowercase `.dev`. |
| GitHub | Github | Brand casing. The live homepage icon title says "Github". |
| Microsoft Teams | MS Teams | Full name in copy. "Teams" after first use. |
| Claude Cowork, ChatGPT Work | Claude Work, ChatGPT Cowork | See `positioning.md` section 4. |
| OpenCode | Opencode, open code | The harness. |

### Product nouns

Use one term per concept. Match the code name. Product nouns are common nouns: lowercase in prose,
capitalized only at the start of a sentence or as a UI label.

| Canonical noun | Means | Say | Never |
| --- | --- | --- | --- |
| project | A git repo that is the company: configuration plus accumulated state. | "Your project is a repo you own." | workspace |
| account | The container of projects and people. A personal account becomes a team account when you invite someone. | "No projects in this account yet." | workspace, organization, tenant |
| session | One unit of agent work on its own cloud computer and branch, owned by whoever or whatever started it. | "Start a session." | chat, thread, conversation |
| cloud computer | The disposable, isolated machine a session runs on. Use when the point is that agents work on a real machine. | "Every session gets its own cloud computer." | container, VM |
| sandbox | The same machine. Use when the point is isolation. | "One isolated sandbox per session." | container, blanket microVM |
| Agent Computer | The name of one marketing page and nav item. Not a product noun. | "Agent Computer" (page name only) | "agent computer" in prose, "Kortix Agent Computer" |
| `kortix.yaml` | The Kortix layer of a project: sandbox image, triggers, connectors, secret names and grants, where agent config lives. | `kortix.yaml` in mono | kortix config, manifest file (in marketing) |
| OpenCode config | The runtime config: agents, skills, commands, tools, plugins, models, providers. | "the OpenCode config" | — |
| change request | The reviewed merge back toward `main`. CLI: `kortix cr`. | "The agent opens a change request you approve." | PR, pull request (in product copy), "the agent deploys" |
| agent | A markdown persona with a prompt and a scoped reach into tools and resources. | "an agent", "install an agent" | bot, assistant, worker, AI worker |
| skill | Markdown plus scripts that encode how the company does one job. | "a skill" | plugin, prompt template |
| connector | One-click reach into an app, an API or an MCP server. Noun "connector", verb "connect". | "Connect Gmail." | integration (as headline noun), plugin |
| secret | An encrypted, per-project credential. It has an exposure: `environment`, `egress-enforced`, `none`. In prose write "egress-enforced". As a CLI argument write `enforced` (the CLI also accepts `egress-enforced`). `none` means no sandbox presence: a Kortix service spends the value, or the secret is stored and disabled (`kortix secrets --help`). | "Environment is the default exposure." | key (generic), "delivery mode" |
| Who can use it | The audience choice on a secret or connector account. | "Who can use it" (UI label, sentence case after the first word) | permissions (for this choice) |
| channel | A chat surface where a bot starts sessions: Slack, Microsoft Teams, email. | "Add Kortix to Slack." | integration, "Telegram channel" |
| trigger | A cron schedule or a signed webhook that starts sessions. | "A trigger starts a session." | automation (as the noun for one trigger) |
| reminder | A prompt that re-prompts one existing session later, once or on repeat. Stored in the database, not in `kortix.yaml`. | "Set a reminder." | trigger (they differ) |
| backend | What an App of kind `convex` is: a database, server functions, realtime queries, file storage and schedules, powered by Convex. The web app labels the kind "Backend". CLI: `kortix apps create <slug> --kind convex` (D13). | "Create a backend." | database, DB, Convex project, app backend |
| computer | A person's own machine connected to Kortix. Name no machine class (laptop, desktop, server) and no operating system (Q20). Not a sandbox. | "Connect your computer." | sandbox or "cloud computer" as a synonym |
| memory | The living company brain. Plain files today. | "company memory" | vector database (external copy) |
| `kortix-sandbox-agent-server` | The daemon a sandbox boots with: it clones the repo, cuts the branch, loads config into a live runtime, and exposes prompting, streaming, files and terminal. Internal: do not use it in customer copy. | `kortix-sandbox-agent-server` in mono, in engineering text only | "agent server", "runtime" |
| LLM gateway | The server-side path that authenticates model-provider requests. | "the LLM gateway" | Kortix Gateway |
| member, people | Humans in an account. Humans and agents are both principals. | "Invite people." | users |
| Allow, Ask, Block | The three connector policy actions as the UI labels them. The code names are `always_run`, `require_approval`, `block`. | "Set Ask on the step that matters." | always_run (in UI), allow/ask/deny |

**Rule.** Use the canonical noun in the table, every time, in every surface. — *Why:* Live copy mixed "workspace" and "account", "thread" and "session", "PR" and "change request", "Kortix Gateway" and "LLM gateway" (`apps/web/translations/en.json:19993,20028,413,1689,10582,11732`). One term per concept is STE-100 and it keeps search and support consistent. — *Where:* every surface. — *When silent:* search the code for the name the code uses and write that. If two names exist, ask.

**Rule.** Write "computer" for a person's own machine and "cloud computer" or "sandbox" for a session's machine. Never write one to define the other, and never contrast them in a sentence. — *Why:* the two rows name different machines. A sentence that says "a computer is not a sandbox" puts the other row's word into the first row's copy (Q13). — *Where:* every surface. — *When silent:* describe the computer by what it is (a person's own machine) and by what runs on it. Omit the contrast.

**Rule.** Write "sandbox" or "cloud computer" for a session's computer. Write "machine" only inside a sanctioned row of [claims.md](claims.md), word for word. — *Why:* one noun per concept. A deck caption said "isolated machine" outside any row (Q25). — *Where:* every surface. — *When silent:* "sandbox".

**Rule.** Write "session ID", "change request", "project" exactly as the code names them (`session_id`). — *Why:* CLAUDE.md: "match the codebase's existing names exactly". — *Where:* app | CLI | docs. — *When silent:* read the API field name and use its words.

**Rule.** Write a Slack thread as "Slack thread", a Teams chat as "Teams chat", and a Kortix unit of work as "session". Never write "conversation" for either. — *Why:* "thread" is a Slack noun and "chat" is a Teams noun. A Kortix session started from either is still a session (Q41). — *Where:* Slack | Teams | docs. — *When silent:* "session" unless you mean the platform's own object. A Teams command that picks a model says "Pick the model for this chat."

**Rule.** Write "people" or "members", never "users". Write "principals" only in IAM docs. — *Why:* The permissions model treats humans and agents as principals. "Users" hides the agent. — *Where:* app | marketing | docs. — *When silent:* "people". The live `/enterprise` page says "Govern actions, not just users" (`en.json:3281`).

### Don't say, prefer

| Don't say | Prefer | Why |
| --- | --- | --- |
| Autonomous Company Operating System, open AGI platform, self-driving companies | AI Operating System | Retired (D1). |
| AI agent platform, agent platform | AI Operating System; "the Kortix API" (SDK) | A category, not a feature. |
| AI command center (as category or title) | AI Operating System | D1, D10. "command center" is a descriptor inside a sentence only. |
| AI Management System, AI management platform | AI Operating System | Retired (D10, 2026-10-04). |
| AIOS, Ai OS, AI-OS, "the OS" alone | AI OS (after the full name) | D10. One spelling. |
| Chatbot, chat box | A workforce that produces real output | Real deliverables, not chat. |
| AI assistant, copilot, AI worker, Super AI Worker | A workforce of AI agents; "an agent" | Org-scale and parallel. Legacy Suna copy. |
| Workflow automation, automation tool | An AI Operating System you own | Not a zap. |
| Container, VM (external copy) | Cloud computer; sandbox | The sanctioned nouns. |
| Plugins, extensions | Connectors (apps), skills (know-how) | The canonical nouns. |
| Integrations (headline noun) | Connectors | One noun. |
| Black box, magic | "Everything is code you own. `grep` your whole company." | Auditable, not hidden. |
| Deploy (an agent's output) | Open a change request; ship | Work lands through review. |
| No-code | "Feels as simple as chat, with code underneath." | Depth under the surface. |
| We host your AI | Open, self-hostable, yours | We do not rent your company back to you. |
| Fully autonomous | "Opens a change request you approve" | A person approves. |
| Please (in UI) | Say what to do: "Try again." | Section 4. |
| Source-available, Elastic License, Apache, MIT | open source | Never name a license. |
| more powerful, fully extensible, seamless, revolutionary, unlock productivity, next-gen, AI-powered magic, transformative, AI transformation | A concrete mechanism | Banned hype. The old brand guide banned "AI transformation" by name (Q41). |
| preview, beta (for email) | experimental, per project | The claim word is "experimental" ([claims.md](claims.md)). The one exception is the sanctioned Companies pitch line in [positioning.md](positioning.md), word for word (Q41). |

### Capitalization and mechanics

**Rule.** Use sentence case for every title, heading, label, button, tab, menu item and table header. Capitalize only the first word and proper nouns. — *Why:* Jay's shipped UI is sentence case ("Copy install command", "Revoke this API key?"; mobile `design.md` rule "sentence case", "Sound pack", not "SOUND PACK"). The live site mixes title case ("Keep Account", "Cancel Account Deletion", `en.json:1225-1228`). — *Where:* app | mobile | marketing | docs | email | CLI. — *When silent:* sentence case. Brand and product names keep their own casing.

**Rule.** Write product objects in lowercase in prose: project, session, agent, skill, connector, secret, channel, trigger, change request. — *Why:* They are common nouns. — *Where:* every surface. — *When silent:* capitalize only at the start of a sentence or as a standalone UI label.

**Rule.** Write config tokens, commands, paths, IDs and keys in mono: `kortix.yaml`, `kortix init`, `kortix ship`, `kortix cr`, `main`, `secrets_egress`. — *Why:* Mono marks a literal the reader can type or search for (see `typography.md`). — *Where:* every surface. — *When silent:* if the reader can type it, set it in mono.

**Rule.** Write "git repo" and "git repository", `main` branch, "change request" in lowercase. — *Why:* The terms are generic, not product names. The live `/enterprise` page writes "Git repo" mid-sentence. — *Where:* every surface. — *When silent:* lowercase.

**Rule.** Write US spelling: center, license, color, program, organization. — *Why:* The code, the docs and the majority of copy are US: `center` 47 vs `centre` 10, `license` 12 vs `licence` 6, `color` 21 vs `colour` 7 in `en.json`. Live pages still write "programme", "Cost centre" and "Enterprise licence" (`landing/content.ts:302,331`, `security-page/content.ts:240`). — *Where:* every surface. — *When silent:* US. Run a spellcheck set to en-US.

**Rule.** Use the single glyph "…" for an ellipsis in a label or a progress state. Do not type three dots. — *Why:* `en.json` has 264 glyphs against 171 three-dot strings. Mobile uses the glyph ("Deleting…", "Loading earlier messages…", `apps/mobile/design.md:272,424`). — *Where:* app | mobile | CLI. — *When silent:* "…". Add it only for an in-progress state or a truncation, never to soften a sentence.

**Rule.** Use the straight apostrophe in strings. — *Why:* 554 of 759 contractions in `en.json` use it, and it survives translation tooling. — *Where:* app | mobile | docs | email. — *When silent:* straight.

**Rule.** Use a spaced em dash ( — ) as one pause per paragraph in marketing and docs prose. Do not use an em dash in a button, label, toast, error or CLI message. — *Why:* README, hero and docs already pair clauses with it (1,201 uses in `en.json`). UI strings need one short sentence, so a period or a colon replaces the dash. — *Where:* marketing | docs | email (body). — *When silent:* use a period.

**Rule.** Use digits for every number in UI and docs, with a thousands separator: 2,500 credits, 3,000+ apps. Write prices as "$40 per seat per month" in prose and "$40 / seat / mo" in a pricing table. — *Why:* Digits scan faster. The pricing source uses the compact form. — *Where:* app | marketing | docs. — *When silent:* digits. Spell out one to nine only in a spoken deck note.

**Rule.** Use the Oxford comma in lists of three or more. — *Why:* README and hero use it ("agents, skills, memory, and connectors"). — *Where:* marketing | docs | email. — *When silent:* include it.

**Rule.** End a UI sentence with a period. Do not end a label, button, tab, menu item, toast of three words or fewer, or table header with one. — *Why:* The strings Jay shipped follow it ("Could not load API keys" as a toast, "That address is not a preview this deployment serves. Open the preview from your session instead." as a full message). — *Where:* app | mobile. — *When silent:* a full sentence gets a period. A fragment does not.

**Rule.** Do not use an exclamation mark. — *Why:* The product is confident, not excited. `en.json` still carries 13 strings ending "!" ("Copied!", "Share link copied to clipboard!"). Jay's strings have none. — *Where:* every surface. — *When silent:* a period, or nothing.

**Rule.** Do not use emoji in Kortix-authored copy. The one exception is a country-flag glyph that labels a language row. — *Why:* The brand is calm and neutral. Emoji add a second visual language and render differently per platform. Slack and Teams messages used 12 emoji literals in `apps/api/src/channels/teams/cards.ts` and a waving hand in the Slack home header. — *Where:* app | mobile | marketing | docs | email | CLI | deck | Slack | Teams | social. — *When silent:* omit it. A platform's own status reaction (a Slack reaction that shows work in progress) is behavior, not copy, and is allowed.

**Rule.** Use "…" in a page `<title>` or a meta description only to truncate. Keep a meta description to 155 characters or fewer. — *Why:* See `positioning.md` section 1. — *Where:* marketing | docs. — *When silent:* rewrite the sentence shorter.

## 4. UI copy rules (derived from the strings Jay ships)

Sources: `apps/web/translations/en.json` (line numbers below), `apps/mobile/design.md`, and the commits
named in each rule. A rule here applies to `apps/web`, `apps/mobile`, and Electron (same web copy).

**Rule.** Name the object in a button or menu label: "Copy install command", "Copy session ID", "Create project", "Revoke key", "Request access". Do not write a bare "Copy", "Connect" or "Submit". — *Why:* A label that names its object is unambiguous out of context, in a screen reader and in a translation. Shipped in #8491, #8207 and #8419 (`en.json:20228`, `1091`; `command-palette.tsx:1661`). — *Where:* app | mobile. — *When silent:* verb first, then the object, in sentence case.

**Rule.** Start a button label with a verb: Save, Create project, Revoke, Delete session, Request access, Try again. — *Why:* The label tells the person what happens. Mobile design rules the same ("Labels name the destination or setting in 1–2 words, sentence case"). — *Where:* app | mobile. — *When silent:* one to three words. "Cancel" is the only non-verb-object label for a dismiss.

**Rule.** State the consequence in plain present tense, second person: "New sessions will use the new repository. Existing sessions cannot restart after the change." and "You go back to the project when it is done." — *Why:* A person decides faster when the result is stated, not implied (`en.json:7`, `19112`; commits 8b3aed8efd, a92fcabd6d). — *Where:* app | mobile. — *When silent:* write what changes, for whom, and when.

**Rule.** Write an error as what failed, then the next action. Use the pattern "Could not {verb} {object}. {Next action}." — *Why:* "Could not load repositories. Try again." gives the person both facts (`en.json:229-230`; commits 48b76b23dc, f4f04cf03d). `en.json` still has about 274 "Failed to…", "Something went wrong" and "An error occurred" strings (count from the verbal audit, 2026-10-01), which name neither. — *Where:* app | mobile | CLI. — *When silent:* name the object that failed, then one action the person can take. If no action exists, say what happened and stop.

**Rule.** Do not write "please". — *Why:* It adds a word and a tone of request. An instruction is an instruction. `en.json` has 53 "Please" strings, for example "Failed to initiate subscription. Please try again." (`en.json:2027`). Jay's strings write "Try again." — *Where:* every surface. — *When silent:* "Try again."

**Rule.** Do not blame the person and do not apologize. — *Why:* "Something went wrong" and "Sorry" give no fact. "The request failed before we could check your access." gives the fact (`en.json:2933`). — *Where:* app | mobile | email | CLI. — *When silent:* state the system event in the active voice.

**Rule.** Write an empty state as one muted line, plus an optional hint. Describe the future state, not the absence: "Sessions you start will show up here". Layout (no icon tile, no card, the pixel mark): [layout.md](../visual/layout.md) section States. — *Why:* `en.json:1449` and mobile `design.md:115` ("No projects yet" plus one "Create project" button). — *Where:* app | mobile. — *When silent:* "{Plural noun you create} will show up here." plus, if the person can act, one button with the verb-first label.

**Rule.** Write a toast as the result in past tense with the object first and no period when it is three words or fewer: "Secret saved", "Labels saved", "Prompt copied", "App access revoked", "Session deleted". — *Why:* A toast reports a finished action beside the page the person stays on (`en.json:74,1586,1693,921`; mobile `design.md:424`). — *Where:* app | mobile. — *When silent:* "{Object} {past participle}". A longer result gets a second line (description) and a period.

**Rule.** Write a failure toast with the same pattern as an error: "Could not save the labels". — *Why:* One pattern for success and failure (`en.json:1587`). — *Where:* app | mobile. — *When silent:* "Could not {verb} {object}". Keep a failure inside a dialog in the dialog.

**Rule.** Write a confirmation dialog as: a question title that names the object, one description that states the effect, then the verb button and "Cancel". — *Why:* "Revoke this app?" / "{name} loses access to your Kortix account at once. To use it again, you approve it again." / "Revoke" (`en.json:918-920`). The button repeats the verb in the title. — *Where:* app | mobile. — *When silent:* title "{Verb} this {object}?", description in the second person with the effect and its permanence.

**Rule.** Write a destructive confirmation with the exact effect, who it hits, and "This cannot be undone." State the effect before the permanence. — *Why:* "Removes this project and everything inside it, for every member. This cannot be undone." (`en.json:652`) and mobile "Delete “{title}”? Its sandbox is destroyed. This cannot be undone." (`design.md:424`). A person reads the cost before the irreversibility. — *Where:* app | mobile. — *When silent:* name what disappears and for whom. Use a typed confirmation only for an account or project delete. The destructive button repeats the verb ("Delete session"), with "Deleting…" while it runs.

**Rule.** Write a permission or approval prompt so it shows what is decided: the action, its arguments, and exactly two choices, "Deny" and "Approve this action". — *Why:* A prompt without arguments asks an unanswerable question. The shipped card shows redacted parameters in place and offers one decision per call (`session-approval-prompt.tsx` header comment). The shipped label today is "Approve this call" (tests assert it), and "call" is an engine noun. Change the label in a UI PR, not in copy. — *Where:* app | mobile | Slack | Teams | email. — *When silent:* "Approve this {connector} action" with the action and arguments visible. Never add a blanket "always allow" button to a prompt.

**Rule.** Write a waiting state as the state plus who acts: "Waiting on approval." with "Anyone who manages this project can approve your request." — *Why:* The person learns the state and who can change it (`en.json:2927,2942`). — *Where:* app | mobile. — *When silent:* "{State}." then one sentence on who acts next.

**Rule.** Write an access-denied or not-found state as a short fact and a way back: "This project is gone." / "The link may be wrong, or someone deleted the project." / "Back to projects". — *Why:* `en.json:2930-2931,2939`. — *Where:* app | mobile. — *When silent:* one fact, one possible cause, one action.

**Rule.** Write a loading state as the object plus "…" only when the wait can exceed one second. For page-level loading, see [layout.md](../visual/layout.md) section States. — *Why:* "Loading earlier messages…" names the wait (mobile `design.md:272`). A skeleton or a spinner needs no word. — *Where:* app | mobile. — *When silent:* no text.

**Rule.** Write a label for a state, not for the engine: "Waiting on approval", "Didn’t finish", "Not shared with you". — *Why:* A status label tells a person what to do next. Raw engine words (`provisioning`, `failed`) belong in docs and `--json`. — *Where:* app | mobile. — *When silent:* what the person can see or do, in sentence case.

**Rule.** Do not write a risk label ("high risk", "medium") on a review row. — *Why:* #7978 (57bce77067) removed risk labels from the Review Center. — *Where:* app. — *When silent:* show the action and its arguments.

**Rule.** Use the same word for the same action everywhere: "Revoke" revokes, "Delete" deletes, "Remove" removes a link but keeps the object, "Disconnect" removes a connection. — *Why:* A reader learns the meaning once. — *Where:* app | mobile | CLI. — *When silent:* pick the verb the API route uses.

**Rule.** Write a start failure as "Could not start the {object}." Do not write "boot" or "provision" in UI copy. — *Why:* the API route is `/start`, and engine words belong in docs and `--json` (Q14). — *Where:* app | mobile. — *When silent:* use the verb of the API route.

**Rule.** Write an expired connector as "The {app} connection expired." with the button "Reconnect {app}". Write "token" only inside the details fold. "Reconnect" re-authorizes. "Disconnect" removes. — *Why:* one noun per concept, and a person fixes a connection, not a token (Q14). — *Where:* app | mobile. — *When silent:* name the app and the object the person can fix.

**Rule.** Write a refused action in two parts: the cause and who can fix it. Name the grant in mono once and write "Anyone who manages this project can grant it." Name the role as "people who manage this project", never "project admin". Branch the cause: "does not have the merge grant" and "cannot merge a change request it opened" are two messages, and only the first names a grant. — *Why:* a grant does not fix the second cause ([claims.md](claims.md) merge rule). The code and the permission example in section 5.3 use this wording (Q14). — *Where:* app | mobile | CLI. — *When silent:* the first message with `project.gitops.merge`. Never write `project.cr.merge`. Add no button unless the app has a screen where the viewer can fix the cause (Q25).

**Rule.** Use one noun for one object inside one error, in the title and in the description. — *Why:* switching from "sandbox" to "session" reads as a second object (Q14). — *Where:* every surface. — *When silent:* the noun in the title.

**Rule.** When a button is the next action, the title and the button are enough. Do not add a description that restates the title. — *Why:* one idea per sentence (Q14). — *Where:* app | mobile. — *When silent:* title plus button.

**Rule.** Label the fold for raw error text "Show details". Label its rows "Message", "Code" and "Request ID". — *Why:* one label for one action across every state ([layout.md](../visual/layout.md) error rule) (Q14). — *Where:* app | mobile. — *When silent:* verb and object, sentence case.

**Rule.** Write a confirmation for "Remove" as the effect and the way back: "{name} loses access to this project at once. To add them again, you invite them again." Use "This cannot be undone." only for "Delete". — *Why:* "Remove" keeps the object, so a claim of permanence is false (Q15). — *Where:* app | mobile. — *When silent:* effect plus the way back.

**Rule.** End every mutation with a result. A mutation that closes its dialog reports with a success toast. A failure stays in the dialog, or shows a failure toast when the control has no inline place. — *Why:* the row or the list changes, and the person needs the result ([layout.md](../visual/layout.md) in-place copy rule). — *Where:* app | mobile. — *When silent:* "Invite sent", "Member removed": object first, past tense.

**Rule.** Label the primary action of a page as verb plus object: "Invite people", "Create trigger". Keep the label that ships today. Do not rename a shipped label in a task that is not about the label. — *Why:* a rename is a separate change and breaks screenshots, docs and support macros (Q16). — *Where:* app. — *When silent:* keep the shipped label and list a mismatch under Guesses.

**Rule.** Write a confirmation for removing an agent as: "{name} loses access to this project at once. To restore access, add the agent to the project again." — *Why:* an agent is not invited by email, so the person-copy way back is wrong (Q25). — *Where:* app | mobile. — *When silent:* effect plus the way back, naming adding the agent. Use "This cannot be undone." only for "Delete".

**Rule.** Write the invite form as email-only with the role defaulting to the lowest-privilege role the list offers. An agent is not invited here. "Kortix emails an invite" is a true sentence (`apps/api/src/accounts/email.ts`). — *Why:* the invite route sends an email. The first role in the list is an accident of array order, not a policy (Q15). — *Where:* app. — *When silent:* email, lowest-privilege role. The host owns validation and role names (intentional freedom).

**Rule.** Put a new web string through the catalog: add a key to the `en` catalog in `apps/web/translations/en.json` and read it with `useTranslations`. — *Why:* the shipped pages do. A hard-coded string skips every locale (Q17). — *Where:* app. — *When silent:* if the tree has no catalog, keep the string inline and list the key under Guesses. Name a new key `{surface}.{state}.{slot}` (for example `triggers.empty.title`). When silent: copy the nearest existing key in the same file (Q25).

**Rule.** Write the empty-state hint as the product noun's one-line "Means" cell from the table in section 3. Write the exact line and the viewer variant freely, inside the pattern above. — *Why:* one definition per noun. The exact wording is intentional freedom (Q4). — *Where:* app. — *When silent:* copy the "Means" cell.

**Rule.** Name a group or section by its object: "Notification types", not "Notify me about". — *Why:* chrome speaks about Kortix in the third person (section 1), and a first-person label puts a voice in the product that no person owns (Q38). — *Where:* app | mobile. — *When silent:* the plural noun, sentence case.

**Rule.** Keep a feature status ("experimental") out of a tab, nav item or button label. Show it on the first body mention ([5.7](#57-docs)) or as a `Badge`. — *Why:* a narrow tab ("Microsoft Teams (preview)") has no room, and the label is the noun the person clicks (Q41). — *Where:* app | marketing. — *When silent:* the noun in the label, the status beside it.

## 5. Tone by context

The voice stays fixed. The tone moves along two axes: how much the reader must decide, and how
much they know. Each block lists the tone, the rules, one approved example, and one rejected
example. All examples are synthetic.

### 5.1 Marketing headline and body

Tone: declarative, concrete, calm. A headline states the mechanism or the offer. The body proves it.

**Rule.** Write a headline as one sentence of 12 words or fewer that states what the reader gets. — *Why:* The home H1 is "The open-source AI Operating System" (7 words). Short lines survive translation and truncation. — *Where:* marketing | deck | store listing. — *When silent:* subject, verb, object; no adjective.

**Rule.** Follow a headline with one sentence of proof from `claims.md`. — *Why:* The hero sub names the pieces: "Your agents, their skills, your company memory and every connector". — *Where:* marketing. — *When silent:* name the three or four objects the reader gets.

**Rule.** Write a call to action as a verb phrase of one to three words. Use "Get started" as the one primary CTA in the header and in the mobile menu. Use "Request demo" as the secondary. — *Why:* The desktop header says "Get started" and the mobile menu's bottom button says "Request demo" (`live-visual` audit). One primary label. — *Where:* marketing. — *When silent:* "Get started".

**Rule.** Write a destination the request omits (a CTA link, a social link, a button URL) as a named placeholder for the object: `{{REQUEST_DEMO_URL}}`. Do not guess a path. — *Why:* a guessed path ships as a dead or wrong link, and two runs invented `/enterprise` and a GitHub URL (Q25, Q41). — *Where:* every surface. — *When silent:* the placeholder, listed under Guesses.

- Approved headline: "Every session gets its own computer." (agent-computer hero, `agent-computer/content.ts:32`)
- Approved body: "A trigger starts a session with no person present. A cron schedule fires it on the clock; a signed webhook fires it on an event." (`automations/content.ts:30`)
- Rejected: "Unlock the power of AI-powered automation with our seamless next-gen platform!" (hype words, exclamation, no mechanism)
- Rejected: "Kortix is the AI command center for your company." (D1: wrong category line)

### 5.2 Store listing

Tone: the same as marketing. Short paragraphs. No tagline stunts.

**Rule.** Build a store listing from the Standard line, the four pillars and the three ways work runs. State the status of anything not public. — *Why:* The live Play listing still says "Super AI Worker" and "genius colleague". Neither mobile app is publicly installable (`download/content.ts` gate). — *Where:* mobile | store listing. — *When silent:* subtitle = Short line; first paragraph = Standard line; then pillars as three short lines.

- Approved first line: "Kortix is an open-source AI Operating System. Your agents, skills, company memory, and connectors in one git repo you own."
- Rejected: "Kortix: Your Super AI Worker. Forget simple chatbots. Meet your genius colleague."

### 5.3 Product UI

Tone: plain, quiet, exact. The person is mid-task. Use section 4 for every string type. Examples:

| String type | Approved | Rejected |
| --- | --- | --- |
| Button | "Create project", "Revoke key", "Request access" | "Submit", "OK", "Click here" |
| Error | "Could not load API keys. Try again." | "Something went wrong. Please try again." |
| Empty state | "Sessions you start will show up here" | "No sessions found!" |
| Toast | "Secret saved" | "Success! Your secret was saved successfully!" |
| Confirm | "Revoke this app?" with "{name} loses access to your Kortix account at once." | "Are you sure you want to do this?" |
| Destructive confirm | "Removes this project and everything inside it, for every member. This cannot be undone." | "Warning: this action is irreversible and may result in data loss." |
| Approval prompt | "Approve this Gmail action" with the recipient and subject shown; "Deny" and "Approve this action" | "Allow this tool to run?" with no arguments |
| Permission explanation | "Anyone who manages this project can approve your request." | "Contact your administrator." |
| Mobile permission prompt (draft, not shipped) | "Kortix needs camera access so you can attach photos to a session." | "Kortix needs camera access to bring you saved conversations with the AI Worker." |

### 5.4 CLI help and errors

Tone: terse, technical, scannable. The reader is in a terminal and may pipe the output.

**Rule.** Write the first help line as "Usage: kortix {command} <subcommand> [options]", then one plain sentence on what the command does, then the subcommand list with a verb-first fragment and no trailing period, then global options, then two or three real examples when the command's help has them. — *Why:* That is the structure of `kortix accounts --help` and `kortix secrets --help` (`apps/cli/src/commands/accounts.ts:15-34`). — *Where:* CLI. — *When silent:* copy the structure of an existing help block. The `kortix secrets --help` block has no examples section: that is the shipped text, not a debt to fill (Q56).

**Rule.** Write a CLI error as one sentence that says what is wrong and what to pass, with the status prefix from `style.ts`: "Pass at least one KEY=VALUE pair." — *Why:* `kortix secrets set` with no arguments prints exactly that after the `✗` prefix. The unknown-command error adds one hint line: "Run kortix --help for the full list, or kortix init <name> to start a new project." — *Where:* CLI. — *When silent:* what is wrong, then the fix, in one or two lines. No stack trace, no apology, no emoji.

**Rule.** Write a CLI success line as the object and the new state: "removed STRIPE_API_KEY", "{agent} now receives {identifier}". Use the `✓` prefix only through `status.ok`. — *Why:* One style from `style.ts:41-44`. — *Where:* CLI. — *When silent:* what changed, with names in bold or mono.

**Rule.** Write stdout for machines (`--json`) with the API's own field names and no prose. — *Why:* Scripts parse it. — *Where:* CLI. — *When silent:* no decoration; honor `NO_COLOR`.

**Rule.** Start a CLI sentence with a capital letter and end it with a period. A list fragment does not end with one. — *Why:* The existing messages mix "removed x" and "Unknown delivery option: x" (`secrets.ts:1244,658`). One rule ends the drift. — *Where:* CLI. — *When silent:* sentence case, period.

**Rule.** Write CLI help and errors from the real binary. Run `kortix <command> --help`, or read `apps/cli/src/commands/<command>.ts`, and quote its subcommands, flags and values. State under Guesses whether the text is "quoted" or "proposed". — *Why:* runs wrote `list` for `ls`, invented `--project` and `--exposure`, and wrote `egress` for the value the CLI prints as `enforced` (Q37). — *Where:* CLI. — *When silent:* if the binary and the source are absent, mark each subcommand, flag and value `{{PROPOSED}}` and list it under Guesses. Do not infer one from this kit.

**Rule.** When the request asks for the help or error text of an existing command, print the shipped text verbatim. Apply only the mechanical fixes of this section (no spaced em dash, no `>`, no three dots) and name each fix. Put any rewrite in a separate block headed `PROPOSED`. Do not condense, reorder or add a section, an options line or an example. — *Why:* a condensed rewrite looks like the real output and hides behavior the real help states (grants, aliases, the 7-day link, `not granted`). The output of a rewrite and the quote differ in 4 paragraphs for `kortix secrets --help` (Q56). — *Where:* CLI. — *When silent:* verbatim first, then `PROPOSED`.

**Rule.** Prefix a message with the helper from `apps/cli/src/style.ts`: `✗` for an error (the command ends), `!` for a warning (the command goes on), `✓` for success, `▸` for a note. — *Why:* a run used `!` for an error and no prefix for another (Q37). — *Where:* CLI. — *When silent:* the `status` helper for the case.

**Rule.** Report a missing required secret as a warning with a count, what happens and the fix. The shipped line is the `!` warning "{n} required secret(s) missing" in `kortix secrets ls`, and sessions still start. Name the fix by case: `kortix secrets set KEY=VALUE` when you hold the value, `kortix secrets request NAME` when a person must enter it. — *Why:* the code treats it as a warning because the session starts (`secrets.ts`). The shipped line uses a spaced em dash that section 1 bans in CLI text: that is debt, not a precedent (Q37). — *Where:* CLI. — *When silent:* "1 required secret is missing. Sessions still start, and a task that needs it may fail." Plural: "{n} required secrets are missing.", rest unchanged. Then one fix line: "Set it with `kortix secrets set KEY=VALUE`, or ask a person with `kortix secrets request NAME`." (Q56)

**Rule.** List every flag the binary still accepts. Tag a deprecated flag "Deprecated." and say what replaces it. Name an accepted alias once, in the line of the value it aliases. — *Why:* help that drops a deprecated flag hides a flag a script still passes (Q37). — *Where:* CLI. — *When silent:* "Deprecated. Use `--allow-host`."

**Rule.** Write a UI path with an arrow, "Settings → Feature flags", and a list continuation as "…" (`KEY=VALUE […]`). Do not write `>` or three dots. — *Why:* the shipped help does, and so do the docs (5.7) (Q37). — *Where:* CLI. — *When silent:* the arrow.

**Rule.** Print the ASCII banner only on the landing screen (`kortix`, `kortix help`, `kortix --help`). A subcommand help block carries the styled title and rule from `formatHelp` and no banner. — *Why:* `printLanding` in `apps/cli/src/index.ts` is the one caller, and a banner above every help block would bury the usage line (Q37). — *Where:* CLI. — *When silent:* no banner.

- Approved: `✗  Pass at least one KEY=VALUE pair.`
- Approved: `kortix: unknown command \`deploy\`` then `Run kortix --help for the full list.`
- Rejected: `Oops! Something went wrong 😕 Please try again later.`
- Rejected: `Error: failed` (names nothing)

### 5.5 Transactional email

Tone: calm, short, safe. The reader did not expect it and may be anxious (security mail).

**Rule.** Write the subject as the action the reader takes, in sentence case, with no brand tagline: "Reset your Kortix password", "Confirm your new email address". — *Why:* `apps/api/src/auth/send-email-hook/templates.ts` subjects. — *Where:* email. — *When silent:* verb, object, one product name at most.

**Rule.** Build the body as kicker (two or three words, sentence case), title (the action), one lead sentence, one button with a verb label, and one closing note on what to do if the reader did not ask: "If you did not request this link, you can ignore this email." — *Why:* Every auth email follows it (`templates.ts:60-100`). — *Where:* email. — *When silent:* never more than one button and one note.

**Rule.** Name the inviter, the object and the role in an invite, name the address the invitation is for, and say what happens if the reader has no account. Without an inviter email, name the account. — *Why:* `apps/api/src/accounts/email.ts` `sendAccountInviteEmail`: subject "You're invited to {collaborate on "{project}" | join "{account}"} on Kortix", lead "{inviter} invited you to join …", one "Review invite" button, and the note "This invitation is for {email}. Sign in with that address, or sign up with it if you don't have a Kortix account yet — … If you were not expecting this invitation, you can ignore this email." Accepting requires the invited address (`email_matches_caller`), so a reader who signs in with another address cannot accept. — *Where:* email. — *When silent:* who, what, role, for whom, one button, one note.

**Rule.** Keep the HTML part of an email that shows the logo above 3,200 bytes. — *Why:* SpamAssassin's `html_image_only` scores an HTML part that contains an `<img>` by its raw length, markup included: 0.726 to 2.799 points between 2,400 and 2,800 bytes (`HTML_IMAGE_ONLY_28`). A dev seed test on 2026-10-02 found every Kortix email between 2,253 and 2,795 bytes. The logo must stay (`visual/brandmark.md`), so the content carries the length. `apps/api/src/__tests__/unit-notifications.test.ts` holds the invite above the window. — *Where:* email. — *When silent:* measure `html.length` of the shortest variant before you cut copy.

**Rule.** End every email with the tagline footer "Kortix — The open-source AI Operating System". Never the retired line. — *Why:* D10. The shipped footer is `BRAND_FOOTER` (`apps/api/src/lib/email/template.ts`) and says the tagline since 2026-10-04. — *Where:* email. — *When silent:* the tagline.

**Rule.** Do not write a kicker or a chip in uppercase. Write it in sentence case. — *Why:* Mono-uppercase is a Badge and deck exception (D4e), not an email style. — *Where:* email. — *When silent:* sentence case.

**Rule.** Build an internal notification (a demo-request alert, a lead alert) in the same shell, with the same footer in the HTML and in the plain text. Write its kicker and title as a noun phrase that names the event: "New demo request". — *Why:* it is mail from Kortix that a person reads. The plain text used to end in "automated lead notification", which differed from the HTML (`demo-request-email.ts`, Q34). — *Where:* email. — *When silent:* `renderEmail` and `BRAND_FOOTER`. Every shipped caller's kicker is a sentence-case noun phrase of two or three words (checked 2026-10-01 in `templates.ts`, `accounts/email.ts` and `demo-request-email.ts`).

- Approved subject: "Reset your Kortix password"
- Approved note: "If you did not request a password reset, you can ignore this email."
- Rejected: "Hey there! Let's get you back in 🚀" (chatty, emoji, exclamation)
- Rejected: "ACTION REQUIRED: VERIFY NOW" (alarm, shouting)

### 5.5b Launch email

Tone: calm, specific, brief. The reader has an account and did not ask for this mail. Section 5.5 rules still apply: subject, footer, no uppercase kicker, no emoji, no exclamation mark.

**Rule.** Build a launch email as: subject (verb plus object), kicker (a noun phrase of two or three words, no colon, the canonical noun), title (what the reader can do now), one lead sentence of 20 words or fewer, the artifact from [magic_trick.md](../magic_trick.md), one button, and one note on why the reader gets this mail. — *Why:* section 5.5 is written for security mail and the reader may be anxious. A launch has a different reader and a different note (Q18). — *Where:* email. — *When silent:* the anatomy above. A second paragraph is allowed only when it carries the artifact.

**Rule.** Write the preheader as one sentence of 40 to 90 characters that states the result and does not repeat the subject or the title. Write the subject, the title and the button label as three different sentences. — *Why:* section 5.5 covers the subject only. A preheader that paraphrases the title wastes the second inbox line, and one idea repeated three times adds nothing (Q18, Q25). — *Where:* email. — *When silent:* the lead sentence, shortened.

**Rule.** Deliver a launch email as the HTML file only, with the subject in `<title>` and in the reply. Put no HTML comment in it, no `TODO(idea)` and no Guesses: the body is pasted into a sending tool. Write a plain-text twin only when the request asks, with the same copy and footer as the HTML. — *Why:* section 5.5 requires the twin for internal notifications and `magic_trick.md` rule 15 bars a comment in a pasted file, and runs could not tell which governs a launch (Q51). — *Where:* email. — *When silent:* HTML only. List "no plain-text twin" under Guesses.

**Rule.** Write the closing note of a launch email as the reason the reader gets it: "You get this email because you have a Kortix account." — *Why:* "If you did not request this" does not apply to mail nobody requests (Q18). — *Where:* email. — *When silent:* one sentence on why.

**OPEN (Q19).** Whether a launch email carries an unsubscribe link and merge tags. No code in this repo sends launch mail: the shell in `apps/api/src/lib/email/template.ts` is transactional. The sending tool decides the tag syntax. Do not invent a tag. Mark `{{UNSUBSCRIBE_URL}}` as a placeholder under Guesses until a person names the tool. A button destination and a hosted logo URL that the request does not supply are placeholders too, named for the object (`{{CONNECT_COMPUTER_URL}}`). A launch email that mentions the computer feature names no machine class and no operating system (Q20).

### 5.6 Slack and Teams messages

Tone: a colleague in a thread. One short message. The agent speaks as "I".

**Rule.** Reply in the thread where the person asked. Lead with the result or the one question you need. — *Why:* Follow-ups stay in context, and a channel stays readable. — *Where:* Slack | Teams. — *When silent:* one to three sentences, then the link to the session.

**Rule.** Write a card header as a short noun phrase or sentence with no emoji: "Connected", "Kortix is connected to this channel". — *Why:* The Slack header "Kortix is connected to this channel" is the model (`apps/api/src/channels/slack/dispatch.ts:569`). The Teams headers carry emoji (`teams/cards.ts:276,342,979`) and the Slack home carries a waving hand (`slack/home.ts`). — *Where:* Slack | Teams. — *When silent:* no emoji; bold the state word.

**Rule.** Write an approval message as the action, the arguments and two buttons, then post the outcome in the same message: "Approved" or "Denied", who decided, and the note. — *Why:* `slack/approval-card.ts:160-175`. — *Where:* Slack | Teams. — *When silent:* same as the in-app prompt (section 4).

**Rule.** Write the app description and the home tab with the Standard line and one sentence on what the app does in Slack. — *Why:* The Slack manifest and home view still carry "AI command center" (`slack-manifest.ts:170`, `slack/home.ts:78,89`). — *Where:* Slack | Teams. — *When silent:* "Start a session from any Slack thread."

- Approved: "Connected. Mention me with a task."
- Approved: "I need access to Gmail to send this. Connect Gmail to this project, then ask again."
- Rejected: "⚡ Kortix commands" (emoji header)
- Rejected: "Your AI command center, right here in Slack." (D1)

### 5.7 Docs

Tone: instructional, exact, second person. The reader wants to finish a task.

**Rule.** Write a docs page with a noun title, a one-sentence description that ends with a period, and a lead paragraph that defines the thing in its first sentence: "A session is one unit of agent work." — *Why:* `apps/web/content/docs/work/sessions.mdx` and `connect/reminders.mdx` open this way. — *Where:* docs. — *When silent:* title = the noun; first sentence = the definition.

**Rule.** Write steps as numbered imperatives. Write UI labels in bold, exactly as the UI spells them. Write paths with an arrow: Settings → Feature flags. Write commands and flags in mono. — *Why:* `docs/connect/teams.mdx` and `project/secrets.mdx`. The reader matches the page to the screen. — *Where:* docs. — *When silent:* copy the label from the UI string.

**Rule.** Use a table for a closed set of options and a callout for one warning. Put the working rule in a callout ("The working rule") at the top of a section that people misread. — *Why:* `secrets.mdx` does this for exposure. — *Where:* docs. — *When silent:* a table when a reader compares; a paragraph when a reader follows.

**Rule.** Mark a feature that is not stable at its first mention: "Email is experimental — enable AgentMail Email under Settings → Feature flags." — *Why:* A reader must not build on a flagged feature by accident. — *Where:* docs | CLI help. — *When silent:* name the flag and its default.

**Rule.** Flag a deprecated or legacy surface in the page. Do not describe it as current. — *Why:* CLAUDE.md: "flag legacy/deprecated surfaces in-doc rather than documenting them as current". — *Where:* docs. — *When silent:* "Deprecated. Use {replacement}."

- Approved: "A reminder sends a prompt into one existing session at a time you set. It fires once, or it repeats until someone removes it." (`connect/reminders.mdx`)
- Rejected: "Kortix is the Autonomous Company Operating System — a cloud computer where a workforce of AI agents runs your company." (retired line; `content/docs/index.mdx:6`)

### 5.8 Deck notes

Tone: spoken, plain, paced. The presenter says it aloud.

**Rule.** Write presenter notes as spoken sentences. Contractions are fine. Write numerals as you say them ("SOC 2 Type One"). No bullet fragments. — *Why:* The notes are the script (`kortix-presentation`, "Presenter notes"). — *Where:* deck. — *When silent:* read the line aloud once; rewrite what you stumble on.

**Rule.** Give each build step one line of notes, about 20 seconds of narration. — *Why:* 25 to 30 builds make a comfortable eight-to-ten-minute video. — *Where:* deck. — *When silent:* one idea per step.

**Rule.** Give a chapter slide a title and the diagram, with no lead paragraph. — *Why:* A second block of prose competes with the narration. — *Where:* deck. — *When silent:* move the sentence into the notes.

**Rule.** Take every claim on a slide from the marketing content modules and `claims.md`. — *Why:* Section 1. — *Where:* deck. — *When silent:* leave the claim out.

**Rule.** Write a note about the merge as "a person approves", or "a person with the merge capability merges". Do not write "reads the diff and merges", "main is your live company" or any isolation sentence that is not the approved note below. — *Why:* an admin can grant the merge capability to an agent, and the other sentences trace to no row in [claims.md](claims.md) (Q28). — *Where:* deck. — *When silent:* the approved note, word for word.

- Approved note: "Each session gets its own sandbox and its own branch. The agent works there. When it wants to keep something, it opens a change request."
- Rejected: "Our revolutionary microVM-isolated agents autonomously deploy to production." (hype, blanket microVM, autonomy, "deploy")

### 5.9 Social

Tone: plain and specific, a person talking. One hook, one idea, one action.

**Rule.** Write every post as one hook, one idea and one action. The first line earns the second. — *Why:* `kortix-social`. — *Where:* social. — *When silent:* if you cannot state the idea in one sentence, split the post.

**Rule.** Write a post for a technical founder or operator, and name that audience under Guesses. Keep X to 280 characters. Make the first 210 characters of a LinkedIn post carry the hook. Limits for other platforms: `kortix-social/references/platform-limits.md`. — *Why:* the size table in `art-direction.md` holds image sizes only, and a run had no length rule (Q29). — *Where:* social. — *When silent:* one audience per post, X at most 280 characters, no thread unless asked.

**Rule.** Deliver each post as plain text in its own file, `<platform>-post.md`, with no front matter. End with one action: a question the reader can answer in a reply, or "Link in the comments." Put no `TODO(idea)` comment inside the file ([magic_trick.md](../magic_trick.md)). — *Why:* a post is pasted into a platform, so the file needs no wrapper and no comment (Q29). — *Where:* social. — *When silent:* as stated.

**Rule.** Post as the Kortix account. "We" is the team. Write no "I" unless the request names a person. Whether a post names Kortix is the author's choice (intentional freedom). — *Why:* a run wrote with no pronoun at all because the account was unknown, and the voice rule in section 1 already sets "we" for the team (Q44). — *Where:* social. — *When silent:* "we" for the team, third person for the product.

**Rule.** Write a literal in a post (`main`, `kortix.yaml`, a command) as plain text, with no backticks. — *Why:* a post is pasted into LinkedIn or X, and neither renders mono: a backtick shows as a character. Section 3 sets literals in mono where the surface can render it (Q53). — *Where:* social. — *When silent:* plain text.

**Rule.** Put links in the first comment or a reply, not in the post body. — *Why:* External links in the body suppress reach on the major platforms (`kortix-social`). — *Where:* social. — *When silent:* "Link in the comments." The target is `{{LINK}}` unless the request names one (section 5.1, Q41).

**Rule.** Write social copy to the same claims and vocabulary as every other surface, with no emoji and no hashtag stack. — *Why:* A post is public and permanent. One voice. — *Where:* social. — *When silent:* zero or one hashtag, only where the platform needs it.

**Rule.** Write a post that compares to Claude Cowork or ChatGPT Work from the README table only. — *Why:* Section 4 of `positioning.md`. — *Where:* social. — *When silent:* no comparison.

- Approved: "A company is going to be a git repository. Agents, skills, memory, connectors: one repo you own. Every session gets its own sandbox and branch."
- Rejected: "🚀 Kortix is the #1 AI agent platform!! Unlock 10x productivity 🔥"

## 6. Pre-flight checklist

- [ ] The line matches the hierarchy in `positioning.md` section 1 for this surface.
- [ ] No retired line and no banned word from section 3.
- [ ] Every product noun is the canonical one, in the right case.
- [ ] Every claim traces to `claims.md`. No invented number.
- [ ] Any competitor is spelled and described per `positioning.md` section 4.
- [ ] "Open source" is used and no license is named.
- [ ] Sentence case, US spelling, "…" glyph, no exclamation mark, no "please", no emoji.
- [ ] UI strings follow section 4: verb-first buttons, errors say what failed and what to do.
- [ ] One audience per sentence.
- [ ] The tone block for this surface in section 5 is followed.
