API routing: Cloudflare Worker switch + ECS Fargate hot-standby

Public API hosts (api./dev-api.) now sit behind a Cloudflare Worker that routes to either EKS or ECS Fargate via an ACTIVE_BACKEND switch — instant, reversible failover. CI now deploys both backends every release so either can serve. Includes accumulated dev fixes since 0.9.49.
