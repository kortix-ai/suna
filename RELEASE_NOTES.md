Provider keys are private by default, and account roles are editable from a group

Sharing a provider key with a whole project is now something you choose
deliberately, and account roles can be changed from a group's member list.

## New

- **Edit a person's account role from a group's member list.** You no longer
  have to leave the group to change what someone is.

## Improved

- **A new API key or ChatGPT account is private by default.** The Add dialog
  opens with "Specific members" selected and you already on the list, so
  sharing a key with everyone in the project is an explicit choice rather than
  the default.
- One place to pick provider keys for a session, and the choice saves.

## Fixed

- Sessions stay usable after the project's repository changes.
- Every role assignment is checked against the owner ceiling, so an assignment
  cannot grant more than the person making it holds.

