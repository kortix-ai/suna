SDK React import and release reliability

Fix the @kortix/sdk React entry point in fresh npm consumers. Declare the llm-catalog publish tool directly so isolated npm publishing succeeds. Refresh a stale trigger manifest once on a cache miss, with a per-project cooldown, so trigger fire converges across API replicas.
