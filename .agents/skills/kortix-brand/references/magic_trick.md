# The magic trick

> **Draft. Founder to confirm (D8e, OPEN in `decisions.md`).** An agent drafted this file from `verbal/concepts.md` and the visual system. The founder owns the idea. Until the founder confirms it, follow the rules below and do not extend them.

Every other file tells you how to stay on brand. This file tells you what to draw and where the copy goes. Read it first. It frames every job.

The standing idea: a company is a git repository, so the reader can look inside it. The proof is a real artifact the reader keeps.

## The rules

**Rule.** Open every hero, slide, social card and launch email with one real artifact the reader keeps: a `kortix.yaml` excerpt, a change request diff, or a session URL. Set it as mono text, or as a real screenshot crop, on a flat surface, with one line of copy beside it. — *Why:* the artifact is the proof that the company is files you can open and read, and no lab-hosted competitor can show theirs. — *Where:* marketing | deck | image | social | email (launch only). — *When silent:* pick the artifact the reader keeps (repo, change request, session). Crop it to 6 lines or fewer.

**Rule.** If no artifact fits the job, write the plain, accurate version, mark the gap with a `TODO(idea)` comment, and list it under Guesses. — *Why:* a campaign idea belongs to a person and has a date. An invented idea is the median output of any AI product. — *Where:* every surface. — *When silent:* leave room beside the copy. Do not invent a replacement idea.

**Rule.** When the output carries a `TODO(idea)`, write this line in your reply: "This is the median. The idea it lacks is: <one line>." Put the `TODO(idea)` itself in Guesses. Put it as a comment in the file only when the file is never pasted (a deck source file, an HTML page). Never put it in a file a person pastes into a platform (a social post). — *Why:* the M score needs the line, and a comment inside a pasted post ships to the public (Q26). — *Where:* marketing | deck | social | email (launch only). — *When silent:* the line in the reply, the marker in Guesses.

**Rule.** When the request supplies no real artifact, write no synthetic excerpt. Use `TODO(idea)` and leave room. — *Why:* a made-up diff or YAML is a claim the code did not make (Q26). — *Where:* marketing | deck | social | email (launch only). — *When silent:* `TODO(idea)`.

**Rule.** A share card (OG) is exempt from the artifact rule: it carries the symbol and the page title, and no `TODO(idea)`. — *Why:* the OG template in [art-direction.md](visual/art-direction.md) is symbol plus title, and the two rules conflicted. The newer, narrower rule wins (Q26). — *Where:* image (OG). — *When silent:* symbol plus title.

**Rule.** Spend color and motion by the rules in [color.md](visual/color.md) and [motion.md](visual/motion.md). — *Why:* this file adds no color or motion rule. — *Where:* every surface. — *When silent:* none: those files hold the answer.

**Rule.** A product screen, a mobile screen, CLI output and a product state (empty, error, toast, confirm, loading, permission) carry no artifact and no `TODO(idea)` marker. — *Why:* a product state reports a system event in the middle of a task, and a CLI line is a fact on a terminal. They have no brand idea to show, and a marker there is noise (Q1, Q37, Q38). — *Where:* app | mobile | CLI. — *When silent:* no marker.

**Rule.** An artifact must prove the line it sits under. Do not set an excerpt that shows a permissive default (`allow_all`) under a headline about control or security. A path in [claims.md](verbal/claims.md) is a claim, not an excerpt: it supplies no artifact. — *Why:* a run chose a `kortix.yaml` excerpt whose default is `allow_all` for a headline "Built to survive a security review", and another left `TODO(idea)` although a claims row named the key (Q36). — *Where:* marketing | deck | social | email (launch only). — *When silent:* `TODO(idea)` and the median line (Q26). The person who supplies the artifact picks the one that proves the headline.

## Three states of the artifact

Pick one state per surface. Copy never sits over the artifact's text.

| State | What the artifact does | Where copy may sit | Use for |
| --- | --- | --- | --- |
| **Subject** | The artifact is the largest element: 6 lines or fewer of mono text on `bg-background` with `border-border`. | One headline above it, flush-left. One proof sentence below it. | Landing hero, slide cover, social card |
| **Texture** | The artifact is cropped at one edge of the surface, large, in `text-muted-foreground`, and `aria-hidden`. It carries no information the copy needs. | The headline sits in the calm area on the opposite side, in `text-foreground`. No overlap. | Section divider, blog cover, social card |
| **Field** | Repeated artifact lines fill a dark art pane in both themes, with a static fallback that paints before any shader (D4d, [graphic-elements.md](visual/graphic-elements.md)). | Copy sits in the content column next to the pane, never on the pane. | Split modal, download card, wallpaper |

## Where a dated idea goes

When a person gives you the idea for a specific launch, page or film, they add it here, newest first, with a date and an owner. Until then there is none.

| Date | Surface | The idea | Owner |
| --- | --- | --- | --- |
| none yet | | | |

## Test

Show the output to someone who has never seen Kortix. Ask: "What can you open and read?" If they have no answer, the output carries the look and not the idea. The score for this test is row M in [qa/fresh-agent.md](qa/fresh-agent.md).
