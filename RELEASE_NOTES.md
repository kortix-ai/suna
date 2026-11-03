One Drive tree, clearer session starts, and multi-domain self-hosting

One Drive tree, clearer session starts, and multi-domain self-hosting

### New
- Browse Drive as one folder tree, with pinned My files and Company folders, project search, and admin access to people's folders. (#11478, #11493)
- See, reply to, and route artifact comments. (#11482)
- See which sandbox image step a session start is waiting on. (#11501)
- Serve a self-hosted instance on multiple domains, move its primary domain in one command, and use domain-aware URLs throughout. (#11526, #11533)

### Improved
- Start a new session's turn up to 0.7 seconds sooner. (#11510)
- Read only the git objects each API request needs instead of whole repositories. (#11492)
- Keep sidebar session rows consistent across widths and touch devices. (#11506)
- Guide agents to act before asking and verify before reporting. (#11497)
- Clarify that connecting Codex means connecting your ChatGPT subscription. (#11498)
- Update the website's company positioning and case studies. (#11514, #11500)

### Fixed
- Close TUI panels with Esc even when it arrives as meta+Esc. (#11486)
- Avoid quadratic trimming of boot-error output. (#11490)
- Wait for a stateless session volume's last save rather than failing, and recover stuck runtimes before declaring them lost. (#11503, #11502)
- Show the saved prompt on failure cards for agent-created sessions. (#11524)
- Explain which SAML values to update before moving a self-hosted domain. (#11527)

### Security
- Reject TRACE and CONNECT requests at the API origin. (#11488)
- Enforce general API edge rate limits and per-credential model request limits at the gateway, with visible credential rate-limit counters. (#11521, #11509, #11520)

### Internal
- Add regression coverage for free-tier managed billing refusals and rejected password sign-in. (#11487, #11489)
- Make goal wake-cap tests independent of the UTC hour and wait for background claim deletion in Telegram bot-swap tests. (#11515, #11525)
- Document owner-only automation refusals, project repository access, unique ledger entries, project-volume ownership, stateless-session architecture, runner-swap cleanup, and finite regional sandbox pools. (#11481, #11504, #11505, #11507, #11511, #11512, #11513, #11529)
- Advance development version bookkeeping after releases 0.14.15 and 0.14.16.
