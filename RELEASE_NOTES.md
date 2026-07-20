Codex models fixed, gateway hardening, and a Git-first project flow

## LLM gateway
- **ChatGPT / Codex models work again.** Fixed the ChatGPT-subscription (`codex/*`) 400s end to end: restored the required `store: false`, stopped sending the unsupported `max_output_tokens`, and started surfacing the real upstream error detail instead of a bare "Bad Request".
- **Anthropic extended thinking** now uses `adaptive` + effort (not the deprecated `enabled` + budget tokens), so non-AUTO reasoning effort no longer 400s on newer Claude models.
- Reworked provider mapping into per-provider adapters typed against each SDK's own option types, with models.dev-driven capability gating — wrong wire shapes are now compile errors.

## Models & providers
- Model picker labels BYOK groups by their real provider (e.g. **Amazon Bedrock**, not "Kortix").
- Model show/hide visibility is now consistent across the picker and settings.

## Projects & Git
- Git-provider-first project creation and management; new projects default to managed repositories.
- Removed an unbuilt "Repository synchronization" placeholder from Git settings.

## Marketplace
- Fixed marketplace item pages returning 500 (they now render correctly, and a missing item 404s).

## Identity (SCIM/IAM)
- Okta group-push renames (`PUT /Groups`) now work; protection for IdP-synced groups; status-first Identity tab with last-sync activity and per-provider cadence.

## CLI & docs
- Avoids 502s on long chat turns; clearer "vision fallback" model labeling; dev CLI installer surfaced in Git settings.
- New "Developing with Kortix" guide covering local instances and the CLI workflow.
