A Slack-style project selector, Stop from Slack and Teams, and a git access fix

Projects open on a Slack-style selector, you can stop a running agent straight
from Slack or Teams, long sessions load and stop faster, and a git access gap
for account members is closed.

## Security

- **An account member could push to a project's main branch they had no rights
  to.** The git proxy checked a personal token against the member's account
  role instead of their project role. It now checks the project role.

## New

- **Pick a project from a Slack-style selector.** `/projects` lists your
  projects and opens them in place.
- **Stop a run from Slack or Teams.** The live card has a Stop button, and
  Teams also gets `/stop`. `/status` in Teams shows the current run and links
  to it.
- **Bring your own Teams bot** with a three-step setup wizard.
- **Review decisions carry a reason.** Request changes in Slack or Teams and say
  what should change.
- **Answer questions in Teams directly.** The question card answers what was
  actually asked, and a tapped answer keeps the question it answered.

## Improved

- Long sessions finish a turn and stop faster: ending a turn and pressing Stop no
  longer re-read or re-write the whole conversation.
- Saved history keeps loading older messages while the sandbox is down.
- Members see only what they can change: session settings, the model picker and
  the sandbox notice no longer show account-level controls they cannot use.
- Members can open the Sessions page.
- The notice about a project's previous repository is a dismissible card with
  one clear update action, in plain language.

## Fixed

- A turn that ends by asking you something is no longer reported as "Task
  complete" in Slack or Teams, and neither is a review still waiting on you.
- A run you stopped on purpose no longer shows as "Run failed" in Teams.
- A failed start is reported as a failure rather than going quiet.
- A Teams review decision requires access to the project.
- The Teams agent picker offers only agents you may run.
- Teams cards no longer show Slack-style formatting.
- A Teams conversation always shows its name, never a raw id.
- `kortix sessions` reads a stopped session's saved transcript.

