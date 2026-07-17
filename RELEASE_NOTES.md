Fixes for OpenAI model routing, provider keys, terminals, and toasts

This release is a focused batch of fixes.

**Fixed**
- OpenAI-compatible models now get the correct `max_tokens` handling based on the model itself rather than the upstream host, so sessions on newer OpenAI models (e.g. gpt-5.6) complete their turns reliably instead of erroring.
- Bring-your-own-key provider credentials are now always shared across your team — the private "Only me" option has been removed end to end, matching how the gateway actually reads keys and avoiding silent "no upstream configured" failures.
- The in-terminal experience is more robust: the sandbox terminal now looks up or creates its pty on demand, so a reconnect no longer closes with "pty not found".
- Approving or denying a request that has already been resolved no longer double-fires a "not found" toast.
