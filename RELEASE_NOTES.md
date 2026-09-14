Account creation you can find, Review Center for everyone, and a steadier session view

### New

- **Review Center is on for every project.** It is no longer behind a feature flag — the routes, registry, contract, web surfaces, CLI, and docs all ship it by default.
- **A public App can recognise you.** `public` used to mean both "anyone with the link may open this" and "nobody is ever recognised". Now an App you share outside your company still greets your own team, shows them the controls a visitor should not see, and records who acted.

### Improved

- **Creating an account is reachable again, and it lands you in the account you created.** The control had no live entry point, and the one path that reached it dropped you back where you started. There is now a "Create an account…" row in the workspace switcher, and creating an account opens its first workspace with that account selected.
- **Connector categories show their true size.** The catalogue counted one page of results and headed every category with "· 1". Categories are now grouped over the complete catalogue on the server, and "View all" filters to the set its heading counted.
- **Secret intake forms read better.** Field hints written by an agent become real links, every non-form step shares one status notice, and the header no longer runs under the close button.
- **Modals opened over modals stack correctly.** A modal opened while another was open could render underneath it; it now takes the layer above, and the switch control meets contrast in both themes.
- **Session hover cards line up.** Sessions carrying a Slack, schedule, or shared marker opened their card inset from the sidebar edge; every row now anchors at the same place.

### Fixed

- **Sending a message no longer makes the transcript jump twice.** An idle send moved the view down and then glided it back. The send is now recognised as the working turn, so the view moves once.

### Internal

- 4xx denials are logged as warnings, not errors. Roughly 43% of production error-level lines were expected denials — expired tokens, a project-scoped token refused a cross-project read, an agent missing a grant — which buried real faults. Severity now follows the status class; the lines stay queryable and Sentry behaviour is unchanged.
- A dropped audit batch now says why. The log recorded the whole failing statement plus its bound parameters — IP addresses, user agents, account and project ids — while hiding the SQLSTATE that distinguishes a transient timeout from a permanent constraint violation. It now reports the code and cause, with no statement text and no parameters.
- A forced test exit raises a workflow annotation instead of a line buried in a 40,000-line CI log.
- The staging deploy asserts the host-only access cookie from `main`, matching what staging already checked.
