### Durable session model controls

`session.setModel()` remains a local preference for later sends from that SDK handle. `session.getModel()` reads the durable pin (`{ model: string | null }`). `session.changeModel(model)` saves the pin without sending a prompt. Pi reconfigures without restarting; the running turn finishes before the next turn uses the new model.

**Agent pins, permissions and precedence.** An agent's configured `model` is a default, not a lock: an authorized caller may replace it with a durable session pin. Changing that pin requires session-owner or workspace-manager lifecycle permission; a scoped agent token also needs `workspace.session.stop`. Workspace visibility alone grants no override permission. The requested model must pass account/model availability and provider-key access checks; changing a pin does not bypass those checks.

The durable pin takes precedence over the default agent/project model when pi initializes or reconfigures. For a turn, an explicit prompt model wins; otherwise an explicitly selected agent's configured model wins, then the current session selection applies. A per-prompt override does not rewrite the durable pin. `switchModel` queues its continuation with the requested model explicitly, so that continuation uses the switch model even if the agent has a model default. The running turn keeps its model; the new selection applies to a later turn.

```ts
await session.switchModel({
  model: 'kortix/glm-5.3-flash',
  prompt: 'Continue verification with the new model.',
  idempotency_key: 'verification-model-1',
});
```

The switch saves the pin and queues the continuation in one database transaction. Reuse the same key and payload after a transport failure. A different payload with the same key is refused. Self-switches are limited to three per hour. A queued continuation waits for the current turn. The response contains `prompt_id` and `deduped`; inspect `push_failed` before reporting live application.

CLI: `kortix sessions model get [session-id]`, `set [session-id] <model>`, and `switch [session-id] <model> --prompt "Continue verification" --idempotency-key verification-model-1`. The new verbs default to `KORTIX_SESSION_ID`. The existing `sessions model <session-id> <model>` remains supported. Never send a peer message to yourself to continue a model switch.
