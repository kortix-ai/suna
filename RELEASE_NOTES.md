Per-call connector accounts, no more guessed account, and a sign-out fix

### New

- **Choose which account a connector runs as, per call.** A connection now carries the accounts you may run it as, and the account is chosen when the connector is called rather than pinned to the whole session. The connector catalog, the SDK and the CLI all report the available accounts and the pinned default, and `connectors/describe` shows accounts instead of only tool counts.
- **An ambiguous connector call is refused, not guessed.** When several accounts are reachable and none is named or pinned as default, the call is denied with `account_required` instead of silently picking one — no more mail sent from the wrong mailbox.
- **Choosing a connector account is discoverable in the CLI** rather than a dead end.

### Improved

- **A connector you have your own accounts for reads as connected**, not "needs setup", and the admin connector list now agrees with what each caller can actually reach.
- Connector accounts are per connection instead of a connector-level strategy, and connections the old strategy flag made unreachable are revoked.
- The sandbox daemon's internals were reorganised behind explicit service boundaries, with its HTTP controllers separated from its adapters.

### Fixed

- **A failed identity check no longer signs you out.** A failed `getUser` round trip used to end the browser session; it no longer does, and the new-connection screen offers Upgrade when you are at the project cap.
- **Connector authorization:** finalizing a connection that the whole project can use now requires the connections-manage capability, matching the gate the connect step already applied. Previously a role with connector-write but not connections-manage could complete a project-wide shared connection.
- Auto-created connections no longer claim to be the default, and the CLI's account column no longer truncates away the pinned-default marker.
- Stale connector banner copy and a dead connector detail shell removed; the account list renders for every direct provider.
