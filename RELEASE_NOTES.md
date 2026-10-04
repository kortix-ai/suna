Permissions decide for agents, and an agent grants only what it holds

## New

- **Permissions decide, for agents as for people.** An agent that holds a permission can do the work end to end. `kortix_permissions: all`, `"*"`, and any list that contains `"*"` mean the same thing. With `all`, an agent can also manage project members and delete the project. Creating credentials stays with people.
- **An agent can grant only what it holds.** When an agent edits an agent's permissions, connectors, secrets, or Apps, it can add only what it holds itself. This applies through every route, change request, and push. An agent that does not hold every grant opens a change request instead of pushing the default branch directly.
- **One authorization path.** Every agent with a `kortix_permissions` grant acts as itself, in every project. The per-project switch back to the authority of the person who started it is gone.
- **One bad permission entry no longer empties an agent.** An entry Kortix cannot grant is skipped, and the rest of the agent's grant stays. `kortix validate` still reports it.
- **The Meta agent is platform-owned.** It runs read-only and appears first in the agent picker.
- **No more active-session limits.** Billing is the only limit on how many sessions run at once.
- **The blog** is served from its own app at `/blog`.

## Improved

- A change-request merge that edits `agents`, `triggers`, or `default_agent` needs the same permission as the direct route.
- The download links (`/download/macos`, `/windows`, `/linux`) fall back to the releases page after 3 seconds if GitHub does not answer.
- Deleting a sign-in removes the accounts that only that person belonged to, and revokes all of that person's credentials.
- The manager's session inventory no longer lists deleted warm drafts.

## Fixed

- `kortix validate` rejects invalid arguments.
- The sandbox's `/turn` request is read correctly before streaming starts.
- The mobile stop icon honors its size.
- The infrastructure audit checks network ACL admin ports separately for IPv4 and IPv6.

