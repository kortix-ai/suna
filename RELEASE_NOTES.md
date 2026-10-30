Document discussions, safer Telegram chats, and faster session startup

Document discussions, safer Telegram chats, and faster session startup

### New
- Discuss documents and comment on selected content in artifacts (8f1877d).

### Improved
- Load models from the live catalog instead of a baked sandbox list, without delaying boot or prompts (#11153, #11161).
- Continue older OpenCode chats on pi and simplify the daemon to Kortix names (#11155, #11200).
- Use one shared desktop browser for Kortix and the user (#11204).
- Render email through the shared channel prompt format and label email cards with Subject (#11190).

### Fixed
- Keep connector sweeps from running back to back on the leader (#11148).
- Reduce changed session journal writes to one INSERT per batch (#11154).
- Filter injected onMessage error noise in the web app (#11169).
- Localize desktop controls and guard bundled translations (#11180, #11175).
- Keep artifact digest turn identities separate and stop code block mutation loops (#11185, #11199).
- Preserve send order for quick Telegram messages (#11191).
- Serve blog routes from the blog app again (#11181).

### Security
- Restrict Telegram session writes to their own chat and connector calls to declared arguments (#11184).
- Restrict Telegram /stop to runs started by the same chat and record each prompt's source (#11189).
- Reject unsafe archive links without uncaught errors (#11195).

### Internal
- Remove the v1 session transcript mirror tables (#11152).
- Preserve bootstrap broadcast exports and restore worker startup coverage (#11156, #11159).
- Keep residential proxy presigning off instance metadata in tests (#11157).
- Restore wake refusal and rollback fixtures, including explicit environment sync (#11163, #11164, #11176).
- Cover explicitly unlocked provider failover (#11168).
- Remove unused daemon WebSocket development dependencies (#11160).
- Use residential IPs for development sandbox templates and document proxy flag behavior (#11198, #11201).
- Advance development version metadata after releases (4ec88c3, f195b88).

- Make promotion conflict detection match GitHub when union merge attributes hide conflicts (#11206).
