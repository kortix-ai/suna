Allow in-session agent switching + wake-race retry + deploy self-heal

**Fixes**
- **Deactivate session agent-lock** (KORTIX_ENFORCE_SESSION_AGENT_LOCK, default off): no more AGENT_SWITCH_REQUIRES_NEW_SESSION 409, in-session agent switching works, and the first prompt of a new session no longer fails. Agent picker unlocked in the UI.
- **Send-retry**: any sandbox 503 now rides the full boot/wake window (~29s) so a prompt to a waking box lands instead of reverting a message that actually ran.
- **deploy-prod self-heal**: assert the Argo app tracks 'prod' and repoint a stranded break-glass rollback before the rollout wait.
- Drata IaC CRITICAL fixed (scoped staging deploy secretsmanager perms); opt-in RELEASE_FAST_TRACK release lane.
