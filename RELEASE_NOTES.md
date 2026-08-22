Fix production webhook delivery and initial prompt completion

Accept webhook requests without a User-Agent at the Cloudflare edge. Mint OpenCode-compatible initial message IDs so webhook-triggered turns complete once instead of replaying.
