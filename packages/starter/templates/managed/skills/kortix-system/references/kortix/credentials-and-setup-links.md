# Credentials and setup links

How to get an API key or a connected app without sending the user to a
settings page.

## The rule

1. **You have the value** (pasted in chat, in a file, "use this key"):
   store it in the same turn. Do not mint a link, do not ask again, never
   echo the value. A `403` means your agent may not write secrets: use rule 2.
2. **You lack the value:** mint a setup link and put its URL in your reply,
   in the same turn. Never ask for a key in chat. Never say "open Customize →
   Connectors".

| You need | Mint | The user gets |
| --- | --- | --- |
| A key, token or other secret value | A secret link: `kortix secrets request` | A fill-in form |
| An app account (Gmail, GitHub, …) | A connect link: `kortix connectors connect` | A sign-in |

Slack is neither: `kortix channels connect` prints its install link. Never
request `SLACK_BOT_TOKEN` and never add a `slack` connector (the slug is
reserved). Both links open a dialog in the web app and a tappable link in
Slack or Teams. A value entered through a link never passes through you.

## Store a value you have

```sh
printf '%s' "$VALUE" | kortix secrets set APOLLO_API_KEY=-                 # runtime (default)
printf '%s' "$VALUE" | kortix secrets set BILLING_API_TOKEN=- --scope connector
```

- `runtime` (the default for `set`): loaded into this session's env (no
  restart) and into later sessions of agents granted it.
- `connector`: kept server-side, spent only by a connector.
- An agent stores `runtime` and `connector` secrets only. Network
  enforcement, host lists and LLM gateway keys are for people (`403`).

## Mint a secret link

```sh
kortix secrets request APOLLO_API_KEY SMARTLEAD_API_KEY --scope runtime   # your code reads them
kortix secrets request BILLING_API_TOKEN                                  # connector (the default)
```

- **`connector` is the default scope of `request`.** The value never reaches
  the sandbox. Pass `--scope runtime` for a key your code or tools read.
- One link asks for several keys. Ask for everything in one message.
- A link lasts 7 days (`--expires <minutes>`, at most 30 days). It can only
  set the names it lists, in this project.
- Minting is not idempotent: every call makes a new link. A looping task
  (trigger, retry) records the link and its `expires_at`, checks whether the
  secret is set, and mints again only when the link expired.
  `kortix secrets request <names> --show` prints the saved link.
- `withheld` in the answer names keys your agent will not receive. Relay the
  `withheld_fix` it returns.

## Mint a connect link

1. The connector is not on the project? Add it now, no CR needed:
   `kortix connectors add <slug> --provider composio --app <app> --apply`.
   Never pick a legacy provider by yourself; ask the user first.
2. Pick the owner before you mint. It is set at sign-in:
   - `--owner project`: a shared account. Every session of the project acts
     as it. Tell the user to sign in as the project's shared identity (a team
     or service account), never their own login.
   - `--owner me` (default): private to this user, used only in their own
     sessions. Use it for a person's own account.
   - Unclear? Ask. Never put a personal login in the shared slot.
3. `kortix connectors connect <slug> [--owner project] --label "<name>"`.
   The label names the account ("Support inbox"), never `me` or an id.
4. Put the URL in your reply and end the turn.

A connector holds several accounts. Pass `--account "<name>"` on each call
(`kortix connectors call <slug> <action> --account "<name>"`): a connector
with several accounts refuses an unnamed call with `account_required`. To
use an existing account, list them (`kortix connectors accounts <slug>`);
mint nothing.

Fix an account with the wrong owner (no in-place change):
`kortix connectors connect <slug> --owner <project|me>` with the right
identity, then `kortix connectors accounts <slug> --default <label>`, then
`kortix connectors connections revoke <connection-id>` on the stray one.

## Write links in the reply

The web app turns each link into a card with the app's logo and a button.

```
I need two apps connected for the report:

https://<app>/connect/ksl_…
https://<app>/connect/ksl_…
```

- One link per line. Never put links in a table.
- One line above them says what they are for.

## After the user fills it in

1. End your turn: the user cannot fill the form while you hold it.
2. A submitted secret sends your running session a follow-up message that
   names the saved keys. Otherwise, when the user says "done", check:
   - a secret: `[ -n "$NAME" ]` in a new shell, or `kortix secrets ls`.
     `KORTIX_PROJECT_SECRET_NAMES` is the list at session start: do not use it.
   - an app: `kortix connectors ls` lists it once connected.
3. Not there yet: say so and wait.

## When it still fails

| You see | Meaning | Do |
| --- | --- | --- |
| `not granted` in `kortix secrets ls`, or `withheld` | The value exists; your agent's `secrets` grant lacks it. | Never say it is unset. Ask the user to enable it for your agent (**Customize → Agents → <agent> → Secrets**, or `kortix secrets grant <NAME> --agent <agent>`), then run `kortix secrets sync`. |
| `undecryptable`, `credential_undecryptable` | Kortix can no longer decrypt the stored value. | Ask the user to enter it again: mint a secret link. |
| `credential_not_shared` | The value is shared with someone this session does not act for (a shared session, a trigger, another member). | Never ask for it again. Name the case; the user runs it in their own private session or shares it (`kortix secrets share <NAME> --everyone`). |
| `409 PERSONAL_SECRET_REQUIRES_PRIVATE_SESSION` | The session uses a value shared only with its person. | Suggest a new session to share. |

## A person's own credential

A secret value is usable by everyone in the project by default. You cannot
change who can use it; the person can. After you store a credential that
acts as the person or holds sensitive data (payroll, a bank, a personal
login), tell them once: "Everyone in the project can use it now. To keep it
to you, run `kortix secrets share <NAME> --user me`." For a value only one
agent's trigger needs, suggest `kortix secrets share <NAME> --agent <agent>`.

## Quick reference

| Goal | Command |
| --- | --- |
| Store a value you have | `kortix secrets set <NAME>=- [--scope connector]` |
| Ask for a value your code reads | `kortix secrets request <NAME…> --scope runtime` |
| Ask for a connector's key | `kortix secrets request <NAME…>` |
| Connect an app account | `kortix connectors connect <slug> [--owner project] --label "<name>"` |
| Check a secret arrived | `kortix secrets ls` |
| Check an app connected | `kortix connectors ls`, `kortix connectors accounts <slug>` |
