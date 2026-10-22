# How to prompt with the kit

A person asks. The agent reads this kit and decides which files to open. The agent starts at `SKILL.md`, then `magic_trick.md`, then the row for the job.

You do not name files. You name the job, the surface and what to attach. One line is enough.

## One-line prompts by job

| Job | Type this | Attach |
| --- | --- | --- |
| Product screen (web) | "Build the project Members page with the Kortix kit: people and agents, role, Invite, Remove." | A screenshot of the nearest existing page, if there is one |
| Mobile screen | "Build the notification-preferences screen for the mobile app with the Kortix kit." | `apps/mobile/design.md` is read by the agent. Attach a screenshot of the nearest screen. |
| Empty state | "Write the empty state for the Triggers page." | Nothing |
| Error or toast copy | "Write the error for a sandbox that failed to boot." | The error code or the log line, with any customer data removed |
| Launch email | "Write a launch email for the feature below. Kortix voice." | The PR text or the changelog line |
| Landing section | "Build one HTML landing section for enterprise security buyers, using the Kortix tokens." | The page it will live on, if it exists |
| Headline or tagline | "Give me five headlines for this page. Use the approved lines." | The page copy |
| Pitch | "Write the 30-second pitch for a platform lead at a mid-size company." | Nothing |
| Deck | "Build a five-slide deck on how a change request lands work on main." | The outline, or the doc it comes from |
| Social post | "Write a LinkedIn post and an X post on: a company is a git repository." | A link to the source piece |
| Image or OG card | "Brief the 1200 by 630 OG card for the security page." | The page URL |
| Logo use | "Place the Kortix logo on this slide for a dark background." | The slide or the layout |
| CLI help | "Write `kortix secrets --help` and the missing-secret error." | The current CLI source file |
| Review | "Review this diff against the Kortix kit." | The diff or the paths |
| Change the kit | "Change the dark border color to X. Follow the kit's change process." | Nothing. The agent edits `visual-system.json` and runs the generator. |

## What to add when you have it

- **The audience.** Developer, company or enterprise buyer. See `verbal/positioning.md`.
- **The one thing the reader should keep.** One noun: the repo, the change request, a session.
- **The surface and its size.** "Slide, 16:9." "OG card, 1200 by 630." "Mobile, iOS."
- **The idea, when you have one.** Put it in the prompt and the agent uses it. Add it to `magic_trick.md` if it should last.

## What you get back

1. The output.
2. A list of the files the agent read.
3. A "Guesses" list: every choice that no file covered.
4. A note when the output is the median.

Read the "Guesses" first. Each one is either a missing rule or a place the kit leaves freedom. Add the rule to the right file, with a `decisions.md` entry, or mark the freedom as intentional.

## Do not

- Do not paste values (colors, sizes, copy) into the prompt to "help". The kit holds them. A pasted value overrides the kit and drifts.
- Do not ask for a new color, font, metaphor or tagline. Ask a person who owns the brand, then record the answer in `decisions.md`.
