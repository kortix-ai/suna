Credit codes, server-side Goals, proactive Spaces, and image-heavy session fixes

Credit codes, server-side Goals, proactive Spaces, and image-heavy session fixes

Credit codes, server-side Goals, proactive Spaces, and image-heavy session fixes

### New
- Credit codes: redeem a code at `/redeem` for credits, and a `/redeem?code=` link survives sign-up. Admins create codes with an expiry and a redemption limit. (#11939, #11944, #11945)
- Goals run on the API: goal state lives on the server, and only a verifier session can mark a goal done. Goals are in the command palette. (#11910, #11882)
- Proactive Spaces: a watcher reads a Space's event feed and speaks up only when it matters. A Space's agents are its router's team; the router does quick work itself and links results as files. (#11865, #11861)
- Every agent gets its session ids, and a subagent can read its parent's conversation. (#11940)
- Watcher Apps: watcher health on the App page, links from a run to its event, one-trigger tests, and a silent or crashing watcher can wake a repair agent. Deleting an App removes the triggers that name it. (#11908, #11907, #11906)
- Hover Artifacts in the sidebar to open any artifact in one click. (#11905)

### Improved
- Spaces keep one conversation: agents read the thread's session log instead of copies. (#11896)
- Only production reports product analytics; dev and staging send nothing. (#11937, #11936)
- Old OpenCode-era code is removed. New audit rows of agent runtime events are named `agent.*` (old rows keep `opencode.*`): update a saved filter or SIEM rule on `opencode.`. (#11938)
- 35 Artifact fixes: comments, drawings, rename, conflicts, load errors, ⌘S retry, link cards, share, hit areas and screen readers. (#11911, #11912, #11916)
- The navbar GitHub link shows at every width; Goals buttons match the menu height. (#11887, #11884)

### Fixed
- Image-heavy sessions no longer fail with "Input is too long", on Bedrock and in Claude Code sessions. (#11934, #11943)
- A session's Stop, probes and failed streams settle; a turn stays busy until it ends; one Stop sends one hold and one abort. (#11928, #11931)
- Session streams end on access loss and never bleed between sessions; client lifecycles survive restarts, stalls and transient errors. (#11929, #11925)
- Lifecycle status writes are compare-and-set, so a stale billing webhook never undoes a newer state. (#11932)
- A session created during a deploy gets a retryable 503 instead of a failure. (#11933)
- History recovery reads session stores larger than 256 MiB. (#11942)
- The Desktop panel stops blinking. (#11930)
- A click after the browser session went stale opens the page instead of the sign-in page. (#11922, #11921)
- An App's restart budget and crash episode, and an app trigger's silence window, survive a deploy or an edit. (#11917, #11909)
- Private channel threads and asks stay private. (#11868)
- A malformed JSON request body gets 400, not 500; a Composio HTML error page becomes a short 502; edge rate-limit headers stay on every route. (#11881, #11897, #11893)
- `send_message` drops a stray approve instead of refusing the message. (#11862)
- An unknown code-fence language renders as plain text. (#11883)
