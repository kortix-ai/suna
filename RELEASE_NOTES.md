Fix the dropped first prompt in new sessions

### Fixed
- **The first message in a new session now runs reliably.** Previously the very first prompt in a brand-new project could silently do nothing, leaving you to send it again. A new session briefly restarts the agent runtime to load its configuration, and the first message was being sent into that restart window and dropped. The first message now waits for the runtime to be ready before it's sent, so it lands on the first try.
