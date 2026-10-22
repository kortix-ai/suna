# Moved

Terraform for the `ec2-vps-demo.kortix.cloud` demo box now lives in its own
repo, [kortix-ai/kortix-vps-demo-infra](https://github.com/kortix-ai/kortix-vps-demo-infra),
on the us-east-1 state bucket `kortix-terraform-state-us-east-1-935064898258`
(key `vps-demo/terraform.tfstate`) instead of this directory's old unlocked
local state. Nothing here is authoritative anymore — go there for plan/apply,
the data-volume safety rule, alarm response, and the restore runbook.
