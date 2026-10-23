---
name: kortix-artifacts
description: "Publish shareable work to the project with the `kortix artifacts` CLI: a `doc` (a spec, report, memo or plan, written in Markdown, which people then edit in place) or an `html` page or bundle (a slide deck, dashboard, design mockup, tool or app). Each publish is a version; people open it in the Kortix app under Artifacts, download it as PDF, and share it with the project, chosen people, or anyone with a link. Load when the user asks for a doc, report, write-up, deck, slides, presentation, dashboard, mockup, page, or anything meant to be read or shared, or names an artifact or an artifact link."
metadata:
  kortix-feature-flag: artifacts
---

<skill name="kortix-artifacts">

<overview>
An artifact is work published to the project, versioned and shareable. The
Kortix app lists every artifact in a gallery, opens it full height, keeps every
version, exports PDF and shares it. You publish and update it with `kortix
artifacts`; the person sees it at once.

Use an artifact when the result is meant to be read, presented or shared. Keep
a code change in the repository, not in an artifact.
</overview>

<types>
Two types. Pick by what a person does with it next.

| Type | For | You write |
|---|---|---|
| `doc` | specs, reports, memos, plans: text people read and edit | **Markdown** (`report.md`). Kortix styles it; people edit it in place like a document. |
| `html` | decks, dashboards, mockups, tools, explainers: anything with its own layout | **Any HTML** with its own CSS and JS, plus files beside `index.html`. Served exactly as written. |

`kortix artifacts types <type>` prints the format rules and a starter page.

**doc** — one `# Title`, then headings, paragraphs, **bold**, *italic*,
`code`, links, bulleted, numbered and task lists (`- [ ]`), quotes, code
blocks, tables, images, `---`. No raw HTML layout, no CSS, no scripts: the
editor keeps only these. Need charts or layout? Make an `html` artifact.

**html** — a complete page. It runs sandboxed: no cookies, no localStorage, no
access to Kortix. Load libraries from a CDN (cdnjs, jsdelivr, unpkg) when you
need them (Chart.js for charts, Reveal.js for decks). Make it work from 360px
to a large screen and in light and dark. "Download PDF" prints the page, so
add `@media print` rules for a deck (one slide per page) or a dashboard.
</types>

<publish>
1. Write the file (`report.md`), or a folder with `index.html` and its assets.
2. Publish it:

       kortix artifacts publish report.md --title "Q3 churn report"
       kortix artifacts publish ./deck --description "Board update, October"

   A `.md` file is a doc; anything else is html. It prints the artifact id and
   its app link. The title defaults to the doc's `# Title` or the page's
   `<title>`.
3. End your answer with the app link and one line on what it shows. Never
   paste the content into the chat.

A new artifact is **private**: the person who runs this session (and you) can
see it. Share it only when the user asks:

    kortix artifacts share <id> --visibility project        # every project member
    kortix artifacts share <id> --with ada@example.com      # chosen people (private)
    kortix artifacts share <id> --visibility public         # anyone with the link

Ask before `public`: a public link works without a login. Never publish
secrets, tokens or customer data in an artifact.
</publish>

<update>
Change an existing artifact instead of publishing a second one:

    kortix artifacts pull <id> ./work          # every file of the current version
    # edit ./work/index.html (a doc is stored as HTML; you may also publish a new .md)
    kortix artifacts publish ./work --id <id> --base-version <n>

Files you leave out are kept; `--remove <path>` drops one. `--base-version`
refuses the publish (exit 3, `version_conflict`) when someone else published
after the version you pulled, for example a person editing the doc: pull
again, merge, publish. `kortix artifacts versions <id>` lists the history,
`restore <id> <n>` brings one back.
</update>

<quality>
- Say the answer first: the doc's opening paragraph, the deck's title slide,
  the dashboard's header.
- Real content only: real numbers with units and dates, no lorem ipsum, no
  placeholder charts. If data is missing, say so on the page.
- Docs: short paragraphs, one idea each, tables for comparisons.
- Decks: one idea per slide, large type, arrow keys to move.
- Check it: `kortix artifacts open <id>` prints a signed `view` URL you can
  fetch to confirm the page loads.
</quality>

<commands>
| Command | Does |
|---|---|
| `kortix artifacts types [<type>]` | types; one type's format and starter |
| `kortix artifacts publish <file\|dir> [--type --title --description --visibility]` | new artifact |
| `kortix artifacts publish <file\|dir> --id <id> [--base-version n] [--remove p]` | new version |
| `kortix artifacts ls [--mine\|--shared\|--pinned] [--type t] [--search q]` | list |
| `kortix artifacts info <id>` / `open <id>` | details, links |
| `kortix artifacts cat <id> [path] [--version n]` / `pull <id> <dir>` | read source |
| `kortix artifacts share <id> --visibility … [--with …]` | share |
| `kortix artifacts rename <id> "<title>"` / `versions` / `restore` / `pin` / `unpin` / `rm` | manage |

Add `--json` for machine-readable output. Reading needs `project.read`;
publishing needs `project.session.start`; changing someone else's artifact
needs its creator or a project manager.
</commands>

</skill>
