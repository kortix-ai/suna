# Strix OSS agentic penetration testing

This lane runs the Apache-2.0 `usestrix/strix` CLI and its local Docker sandbox.
It does not use Strix Cloud. Strix performs source-aware analysis and optional
low-impact dynamic validation against an explicitly allowed development target.

## Prerequisites

- Docker
- `strix-agent==1.0.4`
- `openai-agents==0.18.2` injected into the Strix tool environment
- `LLM_API_KEY` for the configured provider

Strix 1.0.4 pins `openai-agents==0.14.6`, whose LiteLLM adapter fails during
warm-up because it omits `cache_write_tokens`. Version 0.18.2 fixes that runtime
failure. OpenRouter is routed through the OpenAI-compatible endpoint so Strix's
local cost estimator enforces `--max-budget-usd`; its LiteLLM OpenRouter route
currently records `$0.00` and cannot enforce the cap.

## Local run

```bash
uv tool install --force strix-agent==1.0.4
uv pip install --python "$(uv tool dir)/strix-agent/bin/python" openai-agents==0.18.2

export LLM_API_KEY="..."
STRIX_SCAN_MODE=quick \
STRIX_SCOPE_MODE=diff \
STRIX_MAX_BUDGET_USD=5 \
bash tests/security/strix/run.sh
```

For an authorized staging assessment:

```bash
STRIX_SCAN_MODE=standard \
STRIX_SCOPE_MODE=full \
STRIX_TARGET_URL=https://staging-api.kortix.com \
STRIX_INSTRUCTION_FILE=.strix/instructions/deep-api.md \
STRIX_MAX_BUDGET_USD=25 \
bash tests/security/strix/run.sh
```

The committed runner refuses production and unknown remote targets. Reports are
written under ignored `strix_runs/` directories. Exit code `0` means no finding,
`1` means execution failed, and `2` means vulnerabilities were found.
