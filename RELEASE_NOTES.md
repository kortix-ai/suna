Fix false 'agent switch requires a new session' on new sessions

**Fixes**
- Stop the false **AGENT_SWITCH_REQUIRES_NEW_SESSION** 409 that blocked new sessions on the second message. The proxy now treats the `default` agent sentinel as non-binding and only blocks a genuine switch between two distinct concrete agents; for default sessions the echoed agent is stripped so OpenCode runs its booted `default_agent`.
- Agent picker: clearer hover tooltip explaining a session's agent is fixed at start (start a new session to switch); switcher behavior unchanged.
- Includes billing duplicate-suppression and Platinum snapshot upload fixes already on main.
