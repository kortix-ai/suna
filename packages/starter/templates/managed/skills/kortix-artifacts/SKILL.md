---
name: kortix-artifacts
description: "Share work from the project's Files as artifacts with the `kortix artifacts` CLI: a `doc` (a Markdown file people read and edit in place, exportable as PDF) or an `html` page (a slide deck, dashboard, mockup, tool or app). The files stay plain files in Files; every save is a version from the Files history; people open artifacts in the Kortix app under Artifacts and share them with the project, chosen people, or anyone with a link. Load when the user asks for a doc, report, write-up, plan, proposal, spec, decision record, comparison, deck, slides, presentation, dashboard, tracker, mockup, tool, page, or anything meant to be read, kept or shared; when a reply would run past a screen of structured content; or when the user names an artifact or an artifact link."
metadata:
  kortix-feature-flag: artifacts
---

<skill name="kortix-artifacts">

<checklist>
Before every publish:
1. **Title = a name**, 2–4 words, no colon, dash or arrow: `--title "Scheduler migration"`,
   never `--title "Scheduler migration: off the cron VM"`. The explanation goes in
   `--description`.
2. **Share when asked.** "So the team can review it", "share with the team" or
   "for the project" → add `--visibility project`, on the publish or with
   `kortix artifacts share <id> --visibility project`. In a private channel
   (`/drives/README.md` says so) never use `--visibility project` or `public`:
   the artifact stays private to the channel's members.
3. **Answer first**: the recommendation or result is the first paragraph.
4. **One artifact per thing.** Revising an existing one? Save into it (`--id`).
5. **Hand it over with `show`**: `url` = the artifact's app link, `title` = its
   name. The user sees it in the chat and opens it beside the chat. Then one
   line on what it shows.
</checklist>

<overview>
An artifact is a folder in the project's Files, shared. Its files are ordinary
files (`index.md` for a doc, `index.html` plus its images and scripts for a
page). The artifact adds a place in the Artifacts gallery, a viewer, version
history (the Files history of that folder) and share links. Keep a code change
in the repository.

Before you write one, read `references/design.md` (the page contract and the
design method). For any diagram, read `references/diagrams.md`.
</overview>

<when>
Make an artifact when the result is something the user will read, keep, share,
present or come back to: a plan, a spec, a report, a comparison, a deck, a
dashboard, a tool. Also make one when an answer would run past about a screen
of structured content (headings, tables, steps).

Answer in chat when the answer is a few sentences, a quick fact, or a short
list. A code change belongs in the repository, not in an artifact.

Change the existing artifact when the user asks to revise, extend or fix one.
Never publish a second copy (see `<update>`).
</when>

<method>
1. **Read the request.** Name the subject, the reader and the page's single
   job. Choose the type:
   - **doc** for words people read and edit (plans, specs, reports, memos);
   - **html** for anything that needs layout, charts, interaction or slides.

   Choose the treatment (utilitarian, UI or editorial) from
   `references/design.md`.
2. **Gather real content first.** Get real numbers with units and dates, real
   names of things, the user's own terms. Never use lorem ipsum. If data is
   missing, the page says so.
3. **Plan.** For html, write the token plan (colors, type roles, a layout
   line) as the `:root` block before anything else. For a doc, write the
   heading outline first.
4. **Write it once, well.** Lead with the answer. Follow the fundamentals in
   `references/design.md`.
5. **Name it.** Give it a `--title` and a one-sentence `--description` (rules
   below).
6. **Publish, look once, fix once.** See "Check once" in
   `references/design.md`. No loops.
7. **Hand it over.** Call `show` with the app link (`url`) and the name
   (`title`): the chat shows the artifact itself, and the user opens it beside
   the chat. End your reply with one line on what the
   artifact shows. Never paste its content into the chat. Mention the design
   in at most one plain sentence.
</method>

<naming>
The title is the artifact's name in the gallery, beside dozens of others.
- Write a name, not a caption: a short noun phrase, usually 2–4 words,
  specific to the subject ("Q3 churn report", "Pricing page v2", "Card deck").
  A page that answers one question may take that question as its name.
- Use the user's own name for the thing when they have one.
- Never use a bare category ("Report", "Dashboard", "Plan"). Never add an
  explanation after a dash, a colon or an arrow:

  | Wrong | Right |
  |---|---|
  | `Docs search migration: hosted vendor → Postgres FTS` | `Docs search migration` |
  | `Q3 Report – churn, revenue and retention` | `Q3 churn report` |
  | `Dashboard` | `Support queue health` |

  Pass the name with `--title`. The doc's own `# heading` may say more.
- Put the explanation in `--description`, one sentence: the gallery shows it
  under the title.
- Keep the title stable across saves.
</naming>

<planning>
Plans, proposals and decision records are the most common artifact. Make each
one a **doc**, in this order. Skip a section that has nothing true to say.

1. `# <Name>`, then **the recommendation or the decision asked for** in the
   first paragraph: what to do, by when, and what it costs in time or risk.
2. **The problem**, stated as the problem ("signups drop 40% at the email
   step"), not as a pre-chosen solution.
3. **Options:** a table, one row per option, with columns for what matters
   (effort, risk, reversibility, what it unblocks). If the options differ in
   structure, add one mermaid diagram that shows the difference.
4. **The plan:** numbered steps, each with an owner or a done-when.
5. **Risks and unknowns:** one line each (what, why it matters, what resolves
   it).
6. **Next steps:** a task list (`- [ ]`) the reader can tick in the doc.

Write it for a reader who decides without asking you a question. Revise the
same artifact as the plan changes: its history keeps every earlier version.
</planning>

<types>
| Type | For | The file |
|---|---|---|
| `doc` | specs, reports, memos, plans | a **Markdown** file (`report.md`). Kortix renders and styles it; people edit it in place and export it as PDF. |
| `html` | decks, dashboards, mockups, tools | an **HTML** file, or a folder with `index.html` and its assets. Served exactly as written. |

`kortix artifacts types <type>` prints the format rules and a starter.

**doc**: one `# Title`, then headings, paragraphs, **bold**, *italic*,
`code`, links, bulleted, numbered and task lists (`- [ ]`), quotes, code
blocks, tables, ` ```mermaid ` diagrams, images and videos (files in `media/` next to
`index.md`, referenced relatively), `---`. No HTML layout, CSS or scripts.
Need charts or layout? Make an html artifact.

**html**: a complete page, served exactly as written: write the `<!doctype>`,
the viewport meta and the `<title>` yourself. It runs sandboxed (no cookies;
storage may throw; no access to Kortix). Its images, data and scripts sit in
the same folder and load by relative path. Load libraries from a CDN at a
pinned version (Chart.js for charts, Reveal.js for decks). It must work from
400 px to a large screen and in light and dark. The full contract is in
`references/design.md`.
</types>

<publish>
Two ways, same result:

    kortix artifacts publish report.md --title "Q3 churn report"   # uploads to your Artifacts folder in Files
    kortix artifacts publish ./deck                                 # a folder with index.html
    kortix artifacts add /Company/Plans/roadmap                     # shares a folder already in Files (index.md or index.html)

A `.md` file is a doc; anything else is html. The command prints the artifact
id, its path in Files and its app link. Hand it over with `show` (the app link
as `url`) and one line on what it shows. Never paste the content into the chat.

A new artifact is **private**: the person who runs this session (and you) can
see it. Share it when the user asks. "Share it with the team", "something the
team can review" or "for everyone on the project" each mean
`--visibility project`; pass it on the first publish. Named people mean
`--with`. Only an explicit "public" or "anyone with the link" means public:

    kortix artifacts share <id> --visibility project        # every project member
    kortix artifacts share <id> --with ada@example.com      # chosen people (private)
    kortix artifacts share <id> --visibility public         # anyone with the link

Ask before `public`: a public link works without a login. Never publish
secrets, tokens or customer data.
</publish>

<update>
Change the artifact, never publish a second one. Edit its file in Files, or:

    kortix artifacts pull <id> ./work                       # prints the entry_version
    # edit ./work/<file>
    kortix artifacts publish ./work/<file> --id <id> --base-version <entry_version>

`--base-version` refuses the save (exit 3, `version_conflict`) when someone
saved after you pulled, for example a person editing the doc: pull again,
merge, save. `kortix artifacts versions <id>` lists every save from the Files
history; `restore <id> <version-id>` writes one back as a new save.
`kortix artifacts rm <id>` stops sharing; the files stay in Files.
If the request also asks to share ("so the team can review it"), share the
artifact you saved: `kortix artifacts share <id> --visibility project`.
</update>

<quality>
- Say the answer first: the doc's opening paragraph, the deck's title slide,
  the dashboard's header.
- Real content only. Every number has a unit and a date. Every chart is drawn
  to scale.
- Decks: one idea per slide, large type, arrow keys to move.
- Never publish secrets, tokens or customer data. Use synthetic examples
  marked as examples.
</quality>

<commands>
| Command | Does |
|---|---|
| `kortix artifacts types [<type>]` | types; one type's format and starter |
| `kortix artifacts publish <file\|dir> [--title --description --visibility]` | upload and share |
| `kortix artifacts add <folder> [--title --visibility]` | share a folder already in Files; an artifact is always a folder, so a lone file is refused (publish it instead) |
| `kortix artifacts publish <file\|dir> --id <id> [--base-version v]` | save new content |
| `kortix artifacts ls [--mine\|--shared\|--pinned] [--type t] [--search q]` | list |
| `kortix artifacts info <id>` / `open <id>` | details, path, links |
| `kortix artifacts cat <id> [path] [--version v]` / `pull <id> <dir>` | read |
| `kortix artifacts share <id> --visibility … [--with …]` | share |
| `kortix artifacts versions` / `restore` / `rename` / `pin` / `unpin` / `rm` | manage |

Add `--json` for machine-readable output. Permissions (a role's, and for an
agent its `kortix_permissions` in kortix.yaml):

| Permission | Lets you |
|---|---|
| `project.artifact.read` | list, open, read versions and files |
| `project.artifact.write` | publish, add, save, restore; rename and share your own |
| `project.artifact.manage` | rename, share or stop sharing anyone's |
| `project.artifact.public` | give an artifact a public link |

Saving also needs write access to the folder in Files. A refused public link
answers 403 `public_link_forbidden`: share with the project instead and tell
the user.
</commands>

</skill>
