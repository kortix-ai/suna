Faster session lists in large projects

### Fixed

- Projects with thousands of sessions no longer slow the app down. The session list now loads one page at a time — 50 sessions, with a **Load more** control — instead of returning every session on every refresh. On a project with 12,617 sessions that is a 46 KB response instead of about 11 MB, and the sidebar was refreshing it every five seconds.
- Opening, sharing, stopping, restarting or renaming a session now works however old the session is. These controls used to look the session up in the full list, so once a project grew past the first page the controls could quietly disappear.

### Improved

- Date grouping (Today, This week, Older), filters and search work as before, applied to the sessions you have loaded.
- A new database index serves the paged list, so a request no longer sorts every session in the project.

### Security

- The pagination cursor is encrypted and tied to both the project and the person viewing it. It cannot reveal a session they are not allowed to open, and it cannot be reused by anyone else.
