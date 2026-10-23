---
name: kortix-artifacts
description: "Share work from the project's Files as artifacts with the `kortix artifacts` CLI: a `doc` (a Markdown file people read and edit in place, exportable as PDF) or an `html` page (a slide deck, dashboard, mockup, tool or app). The files stay plain files in Files; every save is a version from the Files history; people open artifacts in the Kortix app under Artifacts and share them with the project, chosen people, or anyone with a link. Load when the user asks for a doc, report, write-up, deck, slides, presentation, dashboard, mockup, page, or anything meant to be read or shared, or names an artifact or an artifact link."
metadata:
  kortix-feature-flag: artifacts
---

<skill name="kortix-artifacts">

<overview>
An artifact is a path in the project's Files, shared. The files are ordinary
files in Files (a Markdown file, an HTML file, or a folder with index.html);
the artifact adds a place in the Artifacts gallery, a viewer, version history
(the Files history of that path) and share links. Use one when the result is
meant to be read, presented or shared. Keep a code change in the repository.
</overview>

<types>
| Type | For | The file |
|---|---|---|
| `doc` | specs, reports, memos, plans | a **Markdown** file (`report.md`). Kortix renders and styles it; people edit it in place and export it as PDF. |
| `html` | decks, dashboards, mockups, tools | an **HTML** file, or a folder with `index.html` and its assets. Served exactly as written. |

`kortix artifacts types <type>` prints the format rules and a starter.

**doc**: one `# Title`, then headings, paragraphs, **bold**, *italic*,
`code`, links, bulleted, numbered and task lists (`- [ ]`), quotes, code
blocks, tables, images (absolute URLs), `---`. No HTML layout, CSS or scripts.
Need charts or layout? Make an html artifact.

**html**: a complete page. It runs sandboxed: no cookies, no localStorage, no
access to Kortix. Load libraries from a CDN (cdnjs, jsdelivr, unpkg) when you
need them (Chart.js for charts, Reveal.js for decks). Make it work from 360px
to a large screen and in light and dark.
</types>

<publish>
Two ways, same result:

    kortix artifacts publish report.md --title "Q3 churn report"   # uploads to your Artifacts folder in Files
    kortix artifacts publish ./deck                                 # a folder with index.html
    kortix artifacts add /Company/Plans/roadmap                     # shares a folder already in Files (index.md or index.html)

A `.md` file is a doc; anything else is html. The command prints the artifact
id, its path in Files and its app link. End your answer with the app link and
one line on what it shows. Never paste the content into the chat.

A new artifact is **private**: the person who runs this session (and you) can
see it. Share it only when the user asks:

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
| `kortix artifacts publish <file\|dir> [--title --description --visibility]` | upload and share |
| `kortix artifacts add <folder> [--title --visibility]` | share a folder already in Files; an artifact is always a folder, so a lone file is refused (publish it instead) |
| `kortix artifacts publish <file\|dir> --id <id> [--base-version v]` | save new content |
| `kortix artifacts ls [--mine\|--shared\|--pinned] [--type t] [--search q]` | list |
| `kortix artifacts info <id>` / `open <id>` | details, path, links |
| `kortix artifacts cat <id> [path] [--version v]` / `pull <id> <dir>` | read |
| `kortix artifacts share <id> --visibility … [--with …]` | share |
| `kortix artifacts versions` / `restore` / `rename` / `pin` / `unpin` / `rm` | manage |

Add `--json` for machine-readable output. Reading needs `project.read`;
publishing needs `project.session.start`; saving needs write access to the
path in Files; sharing settings need the artifact's creator or a project
manager.
</commands>

</skill>
