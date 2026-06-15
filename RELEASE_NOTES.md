Reliability: bulletproof ECS hot-standby + managed-git fix

Hardens the dual-backend deploy: CI now fails red if an ECS roll circuit-breaker-rolls-back (was silently green); managed-git Create-project keys made durable; GitHub App key parsing tolerates wrapping quotes. Carries the live fix for project-creation 502s.
