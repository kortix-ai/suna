Faster model responses and a fallback for blocked previews

**Improved**
- Faster, cheaper model calls: the LLM gateway now applies prefix prompt caching on the Bedrock and Anthropic transports, so shared context (system prompt, tools, history) isn't reprocessed on every request.

**Fixed**
- Blocked previews no longer break: when a site refuses to be embedded, the agent shows a link to open the preview URL instead of an empty frame.
