Everything from v0.13.32, plus steadier sessions and grouped outputs

This release restores everything from v0.13.32, which was rolled back, and adds fixes for live transcripts, sleeping sessions, the file viewer and connectors.

## New

- **Grouped outputs.** When the agent shows several results in a row, such as two screenshots, the session renders one tabbed card instead of a card per result.
- **Managed model routes.** Each Kortix-managed model routes through its own provider route, and the model picker shows the price for each route.
- **Wake failures are explained.** When a sandbox fails to wake, the session page shows the failure and when it retries.

## Fixed

- A live session's transcript recovers when a turn ends even if the working signal was missed.
- A session idle for more than a day wakes again, and a failed start is recovered instead of reported lost.
- A config update never interrupts the turn it finds running.
- Kortix owns the `kortix` and `opencode` binaries inside a managed sandbox, so a box cannot end up on a version Kortix cannot heal.
- The file viewer reloads when the explorer switches between the live workspace and the saved copy.
- X and other Composio toolkits with their own OAuth connect again, and the Connected tab stays current.
- Git pushes on branch commits retry a transient failure.
- Audit writes for one session no longer queue behind each other.
- A requested Stop keeps its reason in the turn history.
- Several browser errors from extensions, GPU drivers, closed parent windows and tab discards no longer surface as app errors.

