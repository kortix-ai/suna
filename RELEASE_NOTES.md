v0.10.7

This release is a top-to-bottom overhaul of the LLM gateway — the layer that carries every model request — plus a round of security hardening and sandbox tooling work.

## LLM gateway

The gateway now speaks each provider's API correctly instead of approximately.

- **OpenAI routing and parameters.** Genuine-OpenAI reasoning models that also use tools now route to the `/v1/responses` API, where they belong. We translate `max_tokens` to `max_completion_tokens`, correct the `gpt-5.5` fallback temperature flag, and pin the playground wire shape so what you test is what you ship.
- **Anthropic and Bedrock.** When extended thinking is on, we stop forwarding `temperature`/`top_p` (they conflict with thinking), and Bedrock request/response frames are handled correctly. Bedrock is now available as a standalone bring-your-own-key provider, with its region read from the project's own secret.
- **Transport correctness.** Safer `tool_choice` handling, per-provider parameter quirks, message-role normalization, and correct streaming frames across providers.
- **A LiteLLM translation sidecar** now sits behind the control plane as a stateless translation layer, so provider-shape differences are handled in one place.
- **Streaming reliability.** Aborts propagate end to end, mid-stream errors surface instead of hanging, buffers are bounded, and requests carry deadlines.
- **Error taxonomy.** Failures now come back as honest, actionable errors rather than opaque ones.
- **Billing correctness.** Accurate usage capture, cache-write pricing, and atomic budget holds, with tests to keep them honest.
- A published **capability matrix** documents exactly what each model and provider supports.

## Security

- A DNS-resolving egress guard replaces the old hostname-string regex, closing SSRF gaps.
- Teams bot connector tokens can no longer leak to a caller-supplied `serviceUrl`.
- Sessions reject client attempts to forge `deletedAt`/`deletedBy` metadata.
- Preview shares enforce a view-mode method gate; the Slack file proxy is narrowed to file subdomains; `GET /files/history` gets the resource denier; the MFA-required setting requires an explicit boolean; and malformed AgentMail webhook bodies are rejected before acknowledgement.

## Sandbox and CLI

- New pre-push sandbox gate: the CLI lints your Dockerfile in `validate` and can build sandboxes locally with `sandboxes build --local`.
- The Python floor is venv-isolated, custom `/workspace` contents are preserved, and PTY terminals compile on a supported Bun and recover across providers.
- A stopped sandbox now auto-resumes on active OpenCode access, flipping the session to ready.

## Web and fixes

- Rebuilt session panel with Easy/Advanced modes, new file viewers, and modular tool renderers.
- The project no longer reveals the resolved sandbox provider when the project's provider is set to Automatic.
- Clearer CLI install guidance, corrected OpenCode proxy targeting, and "Kortix Computer is starting" renamed to "Kortix Session is starting."
- Infrastructure: HTTPS-only load-balancer listeners, durable WAF ownership, restored prod gateway origin TLS, and recovered prod migrations and session uploads.
