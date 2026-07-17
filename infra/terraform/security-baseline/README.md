# security-baseline

Account-global SOC 2 / Drata compliance controls as Terraform. Sibling to the
`environments/{dev,prod}` app stacks; own state key `security/baseline.tfstate`.

## What it manages
- IAM account password policy (DCF-68 / DCF-350)
- CloudTrail KMS CMK + multi-region trail + log-file validation + S3 data events (DCF-54 / DCF-478 / DCF-406)
- GuardDuty detectors with 15-minute finding publication and managed EC2/EKS/ECS
  Runtime Monitoring agents in all 17 opted-in commercial regions (DCF-87)
- EBS default encryption in all 17 opted-in commercial regions (DCF-54)
- S3 account-level public access block (DCF-55/78/406 backstop)
- AWS Backup vault + daily plan + selection + service role (DCF-99)
- VPC Flow Logs delivery role + log group (DCF-406)
- IAM groups, attachments, memberships + 2 customer-managed policies (DCF-776)
- Weekly SSM security-patch installation and reboot-if-needed for every current
  and replacement dev/prod EKS worker, serialized one node at a time
  (DCF-152 / DCF-677)
- Regional ALB/WAF/alarm and backup-failure monitoring is isolated in the
  sibling `compliance-monitoring` stack and state.

## Applied via CLI (not in this stack — by design)
These were one-time resource cleanup/remediation actions and live outside the stack; documented
in `../../compliance/SOC2-DRATA-REMEDIATION.md`:
- Deletion of 15 empty regional default VPCs
- Per-VPC flow logs, default-SG stripping, and NACL deny (22/3389) for the 5 us-west-2 VPCs
- S3 per-bucket versioning / TLS-deny policy / access-logging
- The WAFv2 WebACL definitions themselves. This stack discovers all ALBs and
  manages their associations, but reads the existing regional
  `kortix-alb-waf` WebACLs as data sources.
  - WebACL `kortix-alb-waf` exists in us-west-2 and eu-west-2 and is associated
    with every current ALB in those regions.
  - DO NOT block on the `*_BODY` managed sub-rules: this is an API that legitimately carries
    arbitrary user/agent payloads (prompts full of code, file paths like `/etc/passwd`, IPs
    like `127.0.0.1`, git binary thin-packs, bodies well over 8 KB). On 2026-06-04 the
    following sub-rules were set to **Count** (still logged for SOC2, no longer Block) via
    `aws wafv2 update-web-acl` after they 403'd legitimate prompt sends and `git push`:
    - AWSManagedRulesCommonRuleSet: `SizeRestrictions_BODY` (the >8 KB body block — was the
      git-push "~8200 byte" threshold), `GenericLFI_BODY`, `GenericRFI_BODY`,
      `CrossSiteScripting_BODY`, `EC2MetaDataSSRF_BODY`
    - AWSManagedRulesKnownBadInputsRuleSet: `Log4JRCE_BODY`, `JavaDeserializationRCE_BODY`,
      `ReactJSRCE_BODY`
    URI/query/header/cookie rules + AmazonIpReputationList stay in Block. A matching
    Cloudflare custom-firewall `skip` rule (zone kortix.com) skips CF's free managed ruleset
    for the same API hosts, since CF was independently blocking command-injection-like prompt
    content at the edge. Re-blocking any `*_BODY` rule will break prompts + git push again.

## First adoption (resources already exist live)
```bash
terraform init
terraform plan            # import blocks in imports.tf adopt the singletons
# adopt the for_each IAM groups/attachments/memberships:
terraform import 'aws_iam_group.this["administrators"]' administrators
terraform import 'aws_iam_group.this["bedrock-limited"]' bedrock-limited
terraform import 'aws_iam_group.this["bedrock-marketplace"]' bedrock-marketplace
terraform import 'aws_iam_group.this["bedrock-full"]' bedrock-full
terraform import 'aws_iam_group.this["bedrock-count-tokens"]' bedrock-count-tokens
terraform import 'aws_iam_group.this["cloudwatch-logs-writers"]' cloudwatch-logs-writers
# group memberships import as <group-name>/<membership-name> — see `terraform plan` output
terraform plan            # iterate until the diff is empty
terraform apply           # no-op once diff is clean; then delete imports.tf
```

Not applied automatically (mirrors the dev/prod convention).
