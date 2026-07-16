Restore EKS gateway release parity

Stamp KORTIX_VERSION in the EKS gateway Helm chart and in staging/production GitOps bumps so the standby gateway reports the exact promoted release version. This completes the gateway origin TLS recovery and restores six-endpoint version parity across ECS, EKS, and the public router.
