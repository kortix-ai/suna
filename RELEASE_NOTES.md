Correct BYOK billing and refine session layouts

## Fixed

- BYOK model requests no longer reserve, debit, settle, or refund Kortix credits. Provider spend remains visible for diagnostics but is excluded from Kortix charges.
- Active sandbox compute charges now settle every five minutes, so Usage reports compute before a session stops.
- Usage copy now distinguishes Kortix charges from provider charges in all supported locales.
- Session transcripts remain centered when the action panel is collapsed. Sub-agent rows use a clearer tree, and project-home prompts stay in the composer until the session opens.
- Queued prompts use the neutral message surface, and connector setup copy includes the missing spacing.
