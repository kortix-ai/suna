Private provider key pools, print whole conversations, and Entra SCIM fixes

### New

- **Private provider key pools.** Bring several keys for one provider, keep them private or share them with named members, and let each session hold its own key. Sessions fail over to the next key and report the earliest retry time when a pool is exhausted. Gemini and ChatGPT keys pool too, and pooled keys are managed in Models. Pool access is bound to the session owner, and a pool is checked against the model you actually picked.
- **Print a whole conversation.** Cmd+P prints the full session as a clean document — every message, not one clipped screen of the app.
- **Queued prompts you can see and edit.** Queued messages show in a list above the composer. Press Up to edit the last one, and Resume picks the queue back up.
- **Microsoft Teams install reports what happened.** One-click install publishes in the background, lands on Channels with a real status, and offers a retry with the actual reason when publishing fails.
- **Astra** is available as a ChatGPT subscription model.

### Improved

- **Faster project boot.** New sessions fetch the project from storage instead of cloning it, and start sooner.
- **Faster session lists.** A project's session list is now a page, not the whole inventory.
- **Menus open instantly** — menus, popovers, tooltips and the command palette no longer wait to appear.
- **Smaller sandbox images**, which start faster.
- **Git connections** are organized per account, with one instance backend and an identity that cannot drift. Verifying with GitHub no longer signs you out, and the new-connection screen always has a way out.

### Fixed

- **Microsoft Entra directory sync.** Patches apply atomically, large directories paginate, groups survive while a user is inactive or a sign-in session is stale, deactivation and single-member removal behave correctly, and users resolve across the whole directory.
- **The gateway retries a slow internal call** instead of answering "Gateway unavailable".
- **Composer drafts survive session startup**, and opening session settings no longer closes itself while the composer takes focus.
- **One session lifecycle drain at a time** per API task, so queued work is not claimed twice.
- **Session attachments** are more reliable, and model prices show correctly in the ChatGPT picker.
- Security hardening across session cursors, webhook signing keys, and the remaining high-severity scanner findings.
- Database migrations apply cleanly on staging and production.
