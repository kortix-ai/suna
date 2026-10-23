---
name: kortix-artifacts
description: "Publish HTML pages to the project with the `kortix artifacts` CLI: docs (specs, reports, memos), slides (decks), boards (design canvases with artboards), dashboards (KPIs, charts, tables) and plain pages (tools, explainers, apps). Each publish is a version; people open it in the Kortix app under Artifacts and can share it with the project, chosen people, or anyone with a link. Load when the user asks for a doc, report, write-up, deck, slides, presentation, design, mockup, board, dashboard, chart page, or any page meant to be read or shared, or names an artifact or an artifact link."
metadata:
  kortix-feature-flag: artifacts
---

<skill name="kortix-artifacts">

<overview>
An artifact is one HTML page (plus optional supporting files) published to
the project. The Kortix app lists every artifact in a gallery, renders it in a
sandboxed frame, keeps every version, and shares it. You publish and update it
with `kortix artifacts`; the person sees it in the app at once.

Use an artifact when the result is meant to be read, presented or shared: a
report, a spec, a deck, a design, a dashboard. Keep a code change in the
repository, not in an artifact.
</overview>

<types>
The type picks a kit the server adds to your page, so you write plain semantic
HTML and get a finished look. Before you write one, print its format and a
complete starter page:

    kortix artifacts types <type>            # format rules + starter page
    kortix artifacts types <type> --starter  # only the starter page

| Type | For | You write |
|---|---|---|
| `doc` | specs, reports, memos | `<h1>`, `<p>`, `<h2>`, lists, tables, `<pre><code>`, `<aside>` callouts. People can edit the text in place. |
| `slides` | decks | one `<section>` per 1920×1080 slide; classes `title`, `center`, `dark`, `accent`, `cols`, `kicker`, `big`. |
| `board` | designs, mockups, flows | one `<div class="artboard" data-name="…" style="width:…;height:…">` per screen, styled with your own CSS. |
| `dashboard` | metrics | `<header>`, `.kpis` of `.kpi`, a `.grid` of `.card`; charts are `<figure class="chart" data-type="bar|line|area|hbar|donut" data-labels="…" data-series='{"Name":[…]}'>`. |
| `page` | anything else | any HTML, CSS and JS. No kit. |

The kit owns layout, typography, light and dark mode. Do not fight it: add CSS
only for what the format does not cover (a board's artboard contents, a
page's whole design). Inline everything you can; load a library from a CDN
(cdnjs, jsdelivr, unpkg) only when you need it.
</types>

<publish>
1. Write the page to a file (or a folder with `index.html` and its assets).
2. Publish it:

       kortix artifacts publish report.html --type doc --title "Q3 churn report"
       kortix artifacts publish ./deck --type slides --description "Board update, October"

   It prints the artifact id and its app link. The title defaults to the
   page's `<title>`.
3. End your answer with the app link and one line on what it shows. Never
   paste the HTML into the chat.

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
    # edit ./work/index.html
    kortix artifacts publish ./work --id <id> --base-version <n>

Files you leave out are kept; `--remove <path>` drops one. `--base-version`
refuses the publish (exit 3, `version_conflict`) when someone else published
after the version you pulled: pull again, merge, publish. `kortix artifacts
versions <id>` lists the history, `restore <id> <n>` brings one back.
</update>

<quality>
- One clear purpose per artifact; say the answer first (doc lede, title slide,
  dashboard header).
- Real content only: real numbers with units and dates, no lorem ipsum, no
  placeholder charts. If data is missing, say so on the page.
- Docs: short paragraphs, one idea each, tables for comparisons.
- Slides: one idea per slide, three bullets at most, large type.
- Boards: size artboards like real devices; name every artboard.
- Dashboards: 3–6 KPIs, each with a delta and its period; label units.
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
