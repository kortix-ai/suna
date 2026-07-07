Project-wide provider keys, marketplace fixes, and sharper project permissions

**Fixed**
- Connecting an LLM provider with "Only me" access made the key invisible to the model gateway — sessions failed with "No upstream configured" while the provider still looked connected, and flipping an existing key to "Only me" silently left the shared key active for every member. Provider API keys are now always project-wide: the per-user option is gone from the connect flow and the API rejects per-user provider keys outright.
- The marketplace now paginates and virtualizes its listings, and installs no longer fail against a 25-second timeout.
- The detach-role dialog no longer shows a raw translation key and now spaces the role name correctly.
- Removed a distracting fade animation on the sidebar toggle.

**New**
- File and secret access can now be restricted per role: file and secret reads moved to the editor tier, and new groups default to the member grant.
- A warning now appears when a group's built-in grant overrides its assigned custom role.
- The New Project modal has an account picker, so you can choose which workspace a new project lands in.

**Improved**
- A smoother session-starting loader.
- A full accuracy pass over the docs (SDK, CLI, reference, and concepts) against the current code.
