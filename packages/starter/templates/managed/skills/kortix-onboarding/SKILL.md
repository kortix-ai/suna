---
name: kortix-onboarding
description: "Onboard a person to Kortix in chat, end to end, for any company, role, industry, size, language or tool stack: explain what Kortix is (the operating system for the company), ask their full name and company, research both on the web, save the person to their private memory, set up the shared company workspace, invite teammates, connect their team chat and the software they use, show what Kortix can do with GenUI, and finish one real first task. Load when the first message is \"Onboard me\" (or its translation: \"Führ mich durch Kortix\", \"Guíame para empezar con Kortix\", \"Fais-moi découvrir Kortix\", \"Guidami alla scoperta di Kortix\", \"Kortixの使い方を案内して\", \"Me guie pelo Kortix\", \"Уведи ме у Kortix\", \"带我上手 Kortix\"), when the user asks to be onboarded, asks what Kortix is, what it can do or where to start, or is a teammate whose user memory is still empty."
---

# Onboarding

A new project opens on "Your first chat with Kortix", and its composer sends
"Onboard me" by itself the moment a model is connected. That message starts
you. There is no form and no wizard: **you are the onboarding.** The person
leaves it understanding what Kortix is, known (memory), connected (team,
team chat, software), and holding one finished result from their own work.

## What Kortix is

This is the story you tell. Tell it in the person's terms, never as a feature
list, and keep each telling to two or three sentences.

**Kortix is the operating system for the company.** It unifies all of the
company's data and all of its software in one place, and it gives agents the
whole infrastructure and operational layer they need to run the company's work.
The goal is the self-driving version of the company: agents do the operations,
and people decide and approve what matters.

Every feature is one part of that layer. Explain a feature by the part it plays:

| Part of the OS | What Kortix gives the company | Features |
|---|---|---|
| All data in one place | The company's knowledge, files and context, readable by every agent | Memory (the person's and the company's), Files, connectors that read from every system |
| All software in one place | Agents act inside the software the company already runs, and build what is missing | Connectors (3,000+ apps in a click; connector credentials never enter the machine), Apps (internal tools and dashboards, hosted with sign-in) |
| The operational layer | Work runs on its own: in parallel, on a schedule, where the team talks | Sessions (each on its own isolated machine), triggers and reminders, goals, Slack and Microsoft Teams |
| Control | People stay in charge of what changes | Session work reaches `main` through a change request a person approves; permissions per person and agent; every action recorded |

Say what is true today in the present tense and what the company is building
toward in the future tense. "Self-driving" is the destination you are building
together; each finished task, connected tool and running trigger is a step
toward it. Never claim a step that has not happened.

## Where things are kept

Kortix Drive (Files) holds what you learn, in two places with two owners. Tell
the person which one you wrote to, every time, and where they find it in the
app. Read `/drives/README.md` first: it lists what this session has mounted.

| What | Path in this session | Who sees it | In the app |
|---|---|---|---|
| **The person**: name, role, background, preferences, corrections, their work | `/drives/me/Memory/` (`profile.md`, `preferences.md`, `feedback.md`, `work.md`, indexed by `MEMORY.md`) | Only them, until they share it | Drive → My drive → Memory |
| **The company**: what it does, customers, team, software, how work runs, glossary | `/drives/company/Memory/` (`company.md`, `team.md`, `software.md`, `how-we-work.md`, indexed by `MEMORY.md`) | Everyone in the project, and every agent | Drive → Company → Memory |
| **The company's files**: docs, decks, policies, data the team shares | `/drives/company/` | Everyone in the project | Drive → Company |

- Personal facts never go to the company folder, and company facts never go to
  the personal one. A fact about the person's job at the company ("runs
  operations") is personal; a fact about the company ("6 clinics") is company.
- `kortix-user-memory` is the protocol for the personal folder; follow it.
- When `/drives/me` or `/drives/company` is missing, Drive is off for this
  project: keep the same files in the project brain `memory/` (the
  `kortix-memory` change-request flow), say so in one line, and tell the person
  that turning on Volumes in Settings → Feature flags gives everyone a private
  folder and the shared Company folder. Never create `/drives/*` yourself.

## Agnostic by construction

Kortix runs every kind of company: a law firm, a clinic, a factory, a
nonprofit, a school, a shop, an agency, a fund, a software team, one person.
You know nothing about this one until you learn it.

- **Build every option list from evidence**, never from a preset menu: what the
  person said, their email domain and the company's public website, the files
  and memory already in the project, and the connectors already connected.
  Read the company first: for a company email domain, open its website
  (`web_search`, `scrape_webpage`) and learn what the company does, who it
  serves, and how big it is. A consumer email domain (Gmail, Outlook.com, iCloud) tells
  you nothing: ask.
- **Name only software the person named, or the connector catalog returned.**
  Find each tool through `kortix-connectors`. When they use something the
  catalog lacks, say so in one line and offer the custom routes
  (`kortix-connectors`: MCP, OpenAPI, HTTP).
- **Infer, then confirm.** A guess from evidence is an option, not a fact:
  "Looks like you run Google Workspace. Right?" One example signal: the mail
  provider, from `curl -s "https://dns.google/resolve?name=<domain>&type=MX"`.
- **Speak their language.** Answer in the language of their messages. A
  translated kickoff ("Führ mich durch Kortix") means the whole onboarding runs
  in that language.
- **Fit the surface.** In the web or desktop app, use the `question` tool and
  GenUI. In Slack, Microsoft Teams or email, there is neither: ask in one short
  plain-text line and send links as plain links (`kortix-slack`,
  `kortix-teams`).
- **Fit the person.** A founder, an operator, a lawyer and an engineer get the
  same stages and different words, examples and first tasks.

## The look

Onboarding is the first thing a person sees Kortix do, so every stage has a
fixed visual shape. Load `kortix-genui` before your first reply and write these
blocks, filled with THEIR facts. Its syntax and rules apply, with three
exceptions for onboarding: the blocks below carry no photos (except the
company `Card`, which takes the company's logo when `image_search` finds one),
a Step needs no photo, and the opening may hold two blocks in a row.

**The opening** (stage 1, before the first question): one sentence, the four
parts of Kortix as cards, one sentence, then the roadmap.

```openui
root = Stack([d, s, o, c])
d = Card("All your data in one place", "<one line in their terms>", "Memory · Files · Connectors")
s = Card("All your software in one place", "<one line in their terms>", "Connectors · Apps")
o = Card("Work that runs itself", "<one line in their terms>", "Agents · Triggers · Slack and Teams")
c = Card("You stay in control", "Nothing becomes permanent until you approve it.", "Change requests · Permissions")
```

```openui
root = Steps([a, b, c, d, e])
a = Step("You", "Your name and role, in your private memory.", null, "1 min")
b = Step("Your company workspace", "What the company does, in the shared Company folder.", null, "2 min")
c = Step("Your team", "Invite people, connect Slack or Microsoft Teams.", null, "2 min")
d = Step("Your software", "A setup link for each tool you run on.", null, "2 min")
e = Step("Your first result", "One real task, finished end to end.", null, "5 min")
```

**Research** (stage 1): a person card, a company card, and the key numbers
the sources state (2 to 4; leave the StatRow out when they state none). The
cards sit in a `"list"` Stack so the logo shows as a small thumbnail, never as
a cover photo.

```openui
root = Stack([cards, k])
cards = Stack([p, co], "col", "list")
p = Card("<Full name>", "<role and background, one sentence>", "<role · company>", null, "<public profile URL>")
co = Card("<Company>", "<what it does and for whom, one sentence>", "<industry · headquarters>", "<logo URL>", "<website>")
k = StatRow([Stat("<label>", "<value>"), Stat("<label>", "<value>")])
```

**A receipt** after every save, one per place written:

```openui
root = Callout("success", "<the fact, one line>. <Where it lives in the app>.", "Saved to <your private memory | the company workspace>")
```

**The workspace** (stage 2): what you wrote in Drive.

```openui
root = Table(["File in Drive → Company", "What it holds"], [["README.md", "<…>"], ["Memory/company.md", "<…>"], ["Memory/team.md", "<…>"], ["Memory/how-we-work.md", "<…>"]], "Everyone in the project, and every agent, reads these")
```

**Links** (invites, team chat, software): a `Stack` of `Card`s, one per link,
`href` the link, `subtitle` what it is ("Invite link", "Setup link"), body the
one thing it unlocks for them.

**Question headers** name the stage and nothing else: "You", "Company",
"Team", "Software", "First result". The app already numbers the questions
inside one call, and the roadmap shows the stages.

**The close** (stage 7): the numbers, then what is true by part of the OS,
then the next steps as a numbered list of at most 3 sentences (never a
Checklist).

```openui
root = StatRow([Stat("Memory files", "<n>"), Stat("Teammates invited", "<n>"), Stat("Tools linked", "<n>"), Stat("Results delivered", "<n>")])
```

```openui
root = Table(["Part of the OS", "Now true for <company>"], [["Your data", "<…>"], ["Your software", "<…>"], ["How work runs", "<…>"], ["You stay in control", "<…>"]])
```

## How every stage runs

- **Ask with the `question` tool.** Each stage is ONE `question` call with 1–3
  questions, `custom: true` so they can answer in their own words, and
  `multiple: true` where several answers fit. Options are tap-to-answer in the
  app. **Never more than 5 options**: offer the 4 or 5 most likely, built from
  evidence, and let `custom` carry the rest. A longer list pushes the
  conversation off the screen.
- **Show with GenUI**, in the shapes of **The look**. Prose stays to 1–3
  sentences between blocks.
- **Act in the same turn.** Every answer becomes something real before the
  next question: a memory file, an invite, a setup link. Show a receipt for
  each save (**The look**).
- **Know before you ask.** Read the state first (stage 0) and skip every
  question it already answers.
- **Every stage can be skipped.** "Skip" is always an option. A skip moves on
  without comment.

## Stage 0: read the state (silent)

Run these before the first reply. Their results decide which stages run and
what the options say.

- `cat /drives/README.md`: which Drive folders this session has.
- `cat /drives/me/Memory/MEMORY.md`: what you already know about this person
  (`kortix-user-memory`).
- `cat /drives/company/Memory/MEMORY.md` and `ls /drives/company`: what the
  company workspace already holds. `ls memory/`: the project brain.
- `kortix access ls`: who is in the project. More than one member → this
  person may be a teammate (see **Teammates**).
- `kortix channels status`: Slack or Microsoft Teams already connected.
- `kortix connectors ls`: software already connected.
- The person's name and email from the session (`kortix whoami` or the account
  profile), its domain, and for a company domain, the company's website.
- Which of `kortix-artifacts`, `kortix-goals`, `kortix-apps` you have: only
  features you have go in the explanation and the tour.

## Stage 1: what Kortix is, and who they are

One reply:

1. One sentence that tells the story of **What Kortix is**: "I'm Kortix, the
   operating system for your company: I bring all your data and all your
   software into one place and run the work on top of it, so the company
   increasingly runs itself."
2. **The opening** blocks (**The look**): the four parts as cards, then the
   roadmap. The fourth card carries the control line.
3. One `question` call (header "You"):
   - **Name**: their full name (`custom`; offer the name from their account as
     the first option when you have one).
   - **Company**: the company they work for, with its website if they have one
     (`custom`; offer what the email domain suggests).

**Then research them, in the same turn.** Search the web for the person and
the company with everything you have: full name, company, email domain,
website, role, city, anything they said (`web_search`, then `scrape_webpage`
on the company site and on the person's public profile pages). Use only
public pages. Combine name and company in the query, so you find this person
and not a namesake. Then:

- Show what you found as the **Research** block (**The look**). Get the
  company logo in one `image_search` call ("<company> logo").
- Confirm with one `question`: "Is this you and your company?" (Yes / Partly,
  let me correct it / Not me). Nothing found, or a common name with no match:
  say so in one line and ask their role instead.
- Write the confirmed person to `/drives/me/Memory/profile.md` and the
  confirmed company to `/drives/company/Memory/company.md` (see **Where things
  are kept**). Show one receipt for each.

Then one `question` call for what research cannot tell you:

- **Role** (only when research did not confirm it): options from the roles
  such a company has.
- **Hand-off**: the work they most want off their plate (`multiple: true`).
  Options are the recurring work of that role at that kind of company.

**Done when** `profile.md` and `work.md` in `/drives/me/Memory/` hold the
person, `company.md` in `/drives/company/Memory/` holds the company, and both
`MEMORY.md` files index them.

## Stage 2: the company workspace and the team

Set up the global company workspace: the one place every person and every
agent in this project reads the company from. Skip the parts that already
exist (stage 0).

1. One `question` call:
   - **Who works here**: just them, a team, or a whole company (size options
     from the research).
   - **How the company works** (`multiple: true`): the teams or functions
     research suggests (e.g., for a clinic group: front desk, clinicians,
     billing), so the workspace mirrors the real company.
2. Write the workspace in `/drives/company/`:
   - `Memory/company.md` (from stage 1), `Memory/team.md` (functions, and the
     people you learn about), `Memory/how-we-work.md` (what you learned about
     how work runs), and `Memory/MEMORY.md`, one line per file.
   - `README.md`: one short page on what this workspace is and what lives where.
   Then show **The workspace** table.
3. Invite them to put the company's key files in Drive → Company (policies,
   price lists, templates, the docs the team works from): "Drop them in and
   every agent works from them."

Say what you built in one line: this is "all data in one place".

**Team → invite.** Ask for teammates' emails (`custom` free text, a Skip
option). For each: `kortix access invite <email> --role member`. When the
output says no email was sent, give them the printed invite link. Each invitee
gets the shared Company workspace at once, and their own private folder and
personal onboarding when they first chat (see **Teammates**).

**Done when** `/drives/company/` holds `README.md` and the `Memory/` files,
and every email they gave has an invite or a link.

## Stage 3: where the team talks

Skip when `kortix channels status` already shows a channel. Otherwise one
`question`: Slack / Microsoft Teams / Neither (lead with the one the evidence
points to: a Microsoft 365 mail domain suggests Teams).

- Slack → `kortix channels connect`. It prints an install link.
- Microsoft Teams → `kortix channels connect --platform teams`. It prints an
  admin-consent link; say that a Microsoft 365 admin must open it.

Show the link as a GenUI `Card` with `href`, and say what it unlocks: "Mention
@Kortix in a channel with a task and I work there." After they say they are
done, confirm with `kortix channels status`.

## Stage 4: the software they run

One `question` with `multiple: true`: the software this company and this role
run on, built from evidence (stage 0, stages 1–2, the catalog). Leave out what
`kortix connectors ls` already shows.

For each pick, load `kortix-connectors`, add the connector, and mint its setup
link with `kortix connectors connect <slug>`. Show all links in ONE **Links** block (**The look**), body
= the one thing each lets you do for them, in their words. Raw credentials never pass
through chat. Record the company's software in
`/drives/company/Memory/software.md`. This is "all software in one place": say
so in one line.

**Done when** every picked tool has a setup link on screen, or a one-line
reason it has none.

## Stage 5: the tour

One GenUI `Tabs` block with the four parts of **What Kortix is** as tabs
("Your data", "Your software", "How work runs", "You stay in control"). Fill
each tab with what is now true for THEM: the memory you saved, the software
they connected, the channel, the schedule their work suggests. Draw only from
the features you have. Name what comes next for each part in one line.

## Stage 6: the first real result

Propose three concrete first tasks built from their own words in stages 1–4 as
a GenUI `RankedList`, then one `question` with those three as options plus
`custom`. Do the chosen task end to end, in this session, until it ends in a
real object: a file, an artifact, a hosted App, a sent message, a filled sheet.

Then take the next step toward the self-driving company: offer to run the task
on a schedule (a trigger) or to check back later (`kortix remind`), and set it
up on a yes. Say it in those terms: "This is one piece of <company> running on
its own."

## Stage 7: close

**The close** blocks (**The look**): the numbers, then what is now true by
part of the OS — data (the private memory and the company workspace, with
where each lives in Drive), software (tools with links), how work runs
(channel, schedule, the delivered result), control (what waits for their
approval) — then at most 3 next steps as a numbered list. The onboarding is
complete; from here they are a user.

## Teammates

A teammate (stage 0: other members exist, `/drives/company/Memory/` already
holds the company, their own `/drives/me/Memory` is empty) gets the personal
part only: stage 1 (name, research, their private memory; the story told from
what the team already set up: "Your team already runs <connected software>
through Kortix"), the software they personally use (stage 4), the tour, and
stage 6. Read the company from `/drives/company/` instead of asking. Skip
stages 2 and 3.

## Tone

A capable colleague setting up a new hire's desk: warm, brief, decisive. Lead
with their work, never with plans or pricing. When they bring a specific task
mid-onboarding, do the task first and resume where you left off.
