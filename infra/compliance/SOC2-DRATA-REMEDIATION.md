# SOC 2 / Drata Remediation Scope — AWS account `935064898258`

> **STATUS 2026-06-03 — Track A + B DONE (live + verified).** Password policy (14/24) ✓ · CloudTrail KMS+validation+S3-data-events ✓ · GuardDuty 17/17 regions ✓ · 15 empty default VPCs deleted ✓ · 5 us-west-2 VPCs: flow logs + default-SG stripped + NACL deny 22/3389 ✓ · S3 versioning+TLS-deny+access-logging+account PAB ✓ · DynamoDB PITR ✓ · 8 ALB alarms on live LBs ✓ · AWS Backup daily plan ✓ · WAF on both ALBs ✓ · IAM group-ified, 0 direct attachments ✓ · ALB :80-from-world removed ✓ · GitHub `prod` branch protected ✓ · Drata IaC pipeline workflow added ✓ · Terraform `security-baseline/` codified + validated ✓.
> **Remaining = Track C only** (owner-action; see §2 Track C): laptop Drata agents, HR/training docs, IdP/VCS-org MFA, access-key rotation, and the least-privilege (C8) + ECS-autoscaling (C13) + no-Lambda (A13) **risk-accept-vs-scope decisions** in Drata.

**Date:** 2026-06-03
**Author:** infra/compliance pass
**Source of truth:** `Monitoring-06032026.csv` (176 Drata tests; 39 FAILED + 1 ERROR) + live AWS API audit performed 2026-06-03.

---

## 0. TL;DR — approach decision

**Yes — everything that *can* be codified lives as Terraform in `suna/infra/terraform`.** This is the right call and it pays off twice:

1. **Live Drata tests** (Drata reads the AWS API directly) pass once the *real* AWS state is correct — `terraform apply` makes the state correct and durable.
2. **Drata Compliance-as-Code pipeline** (the new `drata/compliance-as-code-action` GitHub Action) scans the repo's **Terraform** for misconfigurations. Codifying the fixes means the IaC scan passes too.

We add **one new account-level Terraform root**: `suna/infra/terraform/security-baseline/` (own state key `security/baseline.tfstate`, same S3 backend). The existing `environments/dev|prod` roots are app infra and stay as-is; we only touch them where the fix belongs to app resources (ALB alarms / WAF on the kortix ALBs).

**Three execution tracks:**

| Track | Tooling | Why |
|-------|---------|-----|
| **A. Terraform baseline** | `security-baseline/` + edits to `environments/*` | Durable, declarative, auditable, feeds the IaC scan. |
| **B. One-time CLI cleanup** | `infra/compliance/scripts/*.sh` | Deleting 15 empty regional default VPCs and stripping orphaned SGs is destructive/one-shot and awkward to express in TF across 16 region-aliased providers. Scripted + idempotent + logged. |
| **C. External / human-owned** | Drata UI, Google/Okta, GitHub org, employee laptops | Cannot be done from this shell (HR docs, endpoint agents, IdP MFA). Documented with exact owner + steps. |

⚠️ **Nothing destructive or access-affecting is applied without an explicit go-ahead.** Items are tagged 🟢 safe / 🟡 confirm / 🔴 owner-coordinated below.

---

## 1. Live AWS state (audit findings, 2026-06-03)

- **Active region: `us-west-2` only** (16 ENIs; VPCs: 4 workload + 1 default). `us-east-1` holds the CloudTrail bucket + trail, no VPC (its default VPC is already deleted).
- **16 other regions** each hold **only an empty default VPC (0 ENIs)** → safe to delete.
- **No IAM account password policy exists at all** → both password tests fail (reuse test errors because there's no policy object).
- **CloudTrail** `management-events` (us-east-1, multi-region): **KMS = none, log-file-validation = false, no S3 data events**.
- **GuardDuty: not enabled in any region.**
- **VPC flow logs: none anywhere.**
- **S3 (5 buckets):** none have a TLS-deny policy; only `kortix-terraform-state` has versioning; none have access logging. No account-level S3 public-access block.
- **DynamoDB:** 1 table `kortix-terraform-locks`, PITR disabled.
- **ALB alarms exist but point to deleted load balancers** (`suna-alb-3975a7d`, `suna-alb-09c3460`); current ALBs `kortix-dev-alb` / `kortix-prod-alb` have **no** alarms → DCF-86 fails.
- **No Lambda functions** in us-west-2/us-east-1/us-east-2.
- **No EC2 Auto Scaling Groups** (workloads run on ECS Fargate with service target-tracking).
- **No AWS Backup** vault/plan.
- **No WAFv2** WebACL.
- **Open SGs (0.0.0.0/0):** ALB SGs on 80+443 (kortix-dev/prod + 3 orphaned), and **`launch-wizard-1` open on tcp/22** in the us-west-2 default VPC.
- **IAM:** 16 users carry direct managed-policy/inline attachments (no groups exist). 3 humans + AWS-managed `AdministratorAccess`. 4 access keys older than 90 days. MFA only on `saumya@kortix.com` + root; `kubet` has console login without MFA.

---

## 2. Remediation matrix (all 40 failing/erroring tests)

### Track A — Terraform `security-baseline` (account-global) 🟢 unless tagged

| # | Drata test | Ctrl | Fix | Risk |
|---|------------|------|-----|------|
| A1 | AWS IAM Password Minimum Length | DCF-68 | `aws_iam_account_password_policy` min length **14** | 🟢 |
| A2 | AWS IAM Password Reuse (ERROR) | DCF-350 | same policy, `password_reuse_prevention = 24` | 🟢 |
| A3 | AWS CloudTrail Logs Encrypted | DCF-54 | new KMS CMK (`alias/cloudtrail`) + key policy; set `kms_key_id` on trail (import existing trail) | 🟢 |
| A4 | CloudTrail Log File Integrity Validation | DCF-478 | `enable_log_file_validation = true` on trail | 🟢 |
| A5 | AWS S3 Object-Level Logging (Read & Write) | DCF-406 | CloudTrail `event_selector` data resource `AWS::S3::Object` read+write | 🟢 |
| A6 | Threat Detection in Place | DCF-87 | `aws_guardduty_detector` (us-west-2 + us-east-1; optionally all regions via aliases) | 🟢 |
| A7 | AWS VPC Flow Logging | DCF-406 | flow logs → CloudWatch Logs for the 4 us-west-2 workload VPCs (default VPCs handled in Track B by deletion) | 🟢 |
| A8 | Cloud Storage Buckets Versioned | DCF-78 | `aws_s3_bucket_versioning` Enabled on the 4 un-versioned buckets (import) | 🟢 |
| A9 | AWS S3 Bucket Access Logging | DCF-406 | new `kortix-s3-access-logs` log bucket + `aws_s3_bucket_logging` on the 5 buckets | 🟢 |
| A10 | AWS S3 HTTP Requests Denied | DCF-55 | `aws_s3_bucket_policy` deny `aws:SecureTransport=false` on all buckets (merge into existing policies) | 🟡 (merge w/ ALB-log bucket policy carefully) |
| A11 | AWS DynamoDB PITR Enabled | DCF-86 | `point_in_time_recovery` on `kortix-terraform-locks` (import) | 🟢 |
| A12 | ALB Target Response Time / Server Errors / Unhealthy Hosts | DCF-86 | new CloudWatch alarms on **kortix-dev-alb / kortix-prod-alb** + target groups → existing `suna-api-alerts` SNS | 🟢 |
| A13 | AWS Lambda Error Rate Monitored | DCF-86 | **No Lambdas exist** → either auto-passes on rescan, or **Drata exclusion** w/ "no Lambda functions in account" justification | 🟡 decision |
| A14 | Daily Backups Monitored | DCF-99 | `aws_backup_vault` + daily `aws_backup_plan` + selection (DynamoDB table; EBS/RDS if added) | 🟢 |
| A15 | Web Application Firewall in Place | DCF-88 | `aws_wafv2_web_acl` (AWS managed rule groups) + association to kortix-prod-alb (+dev) | 🟡 confirm (rule groups can block edge cases) |
| A16 | AWS IAM Group-Based Access Control | DCF-776 | create groups (`administrators`, `bedrock-api-keys`, `bedrock-full`, `cloudwatch-logs-writers`), attach policies to groups, add users, **detach direct/inline** | 🟡 confirm (perms preserved, but detach is sensitive) |
| A17 | AWS VPC Default Security Groups Restrict All Traffic (us-west-2) | DCF-85 | strip ingress+egress from the 5 us-west-2 default SGs (all have 0 ENIs) | 🟢 |

### Track B — One-time CLI cleanup

| # | Drata test(s) | Ctrl | Fix | Risk |
|---|---------------|------|-----|------|
| B1 | Default SG (×15) + NACL admin ports (×15) + Flow logging (×15) | DCF-85/73/406 | **Delete the 15 empty regional default VPCs** (ap-south-1, eu-north-1, eu-west-1/2/3, ap-northeast-1/2, ca-central-1, sa-east-1, ap-southeast-1/2, eu-central-1, us-east-2, us-west-1). Clears 3 findings × 15 regions at once. | 🟡 confirm (destructive but resources are empty; recreatable) |
| B2 | AWS Network ACLs admin ports (us-west-2) | DCF-73 | add explicit **DENY tcp/22 + tcp/3389 from 0.0.0.0/0** (low rule #) to the us-west-2 default NACLs, or risk-accept on workload VPCs | 🔴 confirm (touches live network ACLs) |
| B3 | AWS Security Groups HTTP Access Restricted | DCF-85 | remove tcp/22 0.0.0.0/0 from **`launch-wizard-1`** (verify unused first); remove port-80 0.0.0.0/0 from ALB SGs **or** risk-accept (port 80 = HTTP→HTTPS redirect); delete 3 orphaned ALB SGs | 🔴 confirm (port-80 removal affects http→https redirect) |

### Track C — External / human-owned (cannot be done from this shell)

| # | Drata test | Ctrl | Owner action |
|---|------------|------|--------------|
| C1 | MFA on Cloud Infrastructure | DCF-67 | Enroll MFA for IAM user `kubet` (has console login, no MFA), or remove its console access. |
| C2 | MFA on Identity Provider | DCF-67 | Enforce MFA in Google Workspace / Okta org-wide. |
| C3 | MFA on Version Control System | DCF-67 | GitHub org → require 2FA for all members. *(Can be done via `gh` if you authorize — see §4.)* |
| C4 | Production Code Changes Restricted | DCF-6 | GitHub branch protection on `kortix-ai/suna` `main` (require PR + review + no direct push). *(`gh`-doable.)* |
| C5 | Only Authorized Employees Change Code | DCF-4 | Same branch protection + CODEOWNERS. *(`gh`-doable.)* |
| C6 | Formal Code Review Process | DCF-5 | Require ≥1 approving review in branch protection. *(`gh`-doable.)* |
| C7 | AWS IAM Access Key Rotation | DCF-783 | Rotate keys >90d: `markokraemer` (239d), `saumya-bedrock` (200d), `saumya@kortix.com` (146d), `kortix-cloudwatch-logs` (147d). **Each rotation breaks its consumer** → must coordinate per key (who/what uses it). |
| C8 | AWS IAM Principle of Least Privilege | DCF-776 | The flagged resource is AWS-managed `AdministratorAccess` (`*:*`) being *in use*. Group-ifying (A16) does **not** clear it. Either scope humans down to tailored policies, or **risk-accept named human-admins in Drata** with justification + MFA as compensating control. **Decision required.** |
| C9 | Policies Acknowledged / Code of Conduct / Acceptable Use | DCF-32/44/37 | Employees acknowledge in Drata. HR/admin. |
| C10 | Employee Background Checks | DCF-39 | Record in Drata. HR. |
| C11 | Security Awareness Training Completed | DCF-36 | Assign/complete training in Drata. HR. |
| C12 | Password Manager / Disk Encryption / Screen Lock / Auto-Patch / Malware Detection on Employee Computers | DCF-49/52/48/51/50 | Install the **Drata agent** on every employee laptop; it reports these automatically. Endpoint/human. |
| C13 | Autoscaling Configurations in Place | DCF-97 | Workloads use **ECS Fargate service auto-scaling**, not EC2 ASG. Either confirm Drata accepts the ECS scalable target, or **risk-accept** (no EC2 ASG by design). Decision required. |

---

## 3. Drata Compliance-as-Code CI/CD pipeline (new request)

- Add `.github/workflows/drata-compliance.yml` to `kortix-ai/suna` running `drata/compliance-as-code-action@v1.0.0` on push, `minimumSeverity: CRITICAL`.
- Uses repo secret **`DRATA_IAC_PIPELINE_KEY`** (already stored) + `GITHUB_TOKEN`. **The key value is never committed — referenced via `${{ secrets.DRATA_IAC_PIPELINE_KEY }}` only.**
- Scope it to `infra/**` Terraform paths so it scans the IaC we add.
- Pipeline fails if any test ≥ CRITICAL fails → keeps the baseline from regressing.

---

## 4. Execution order

1. **Track A safe items** (A1–A12, A14, A17) — build TF in `security-baseline/`, import existing resources, `plan`, review, `apply`.
2. **Track B1** default-VPC deletion (confirm) — CLI script.
3. **Track A16 / B2 / B3 / A15** (confirm-gated) — IAM groups, NACL deny, SG tightening, WAF.
4. **CI/CD pipeline** workflow file (§3).
5. **Track C** — hand off the owner checklist; do the `gh`-doable GitHub items if authorized.
6. **Re-run tests in Drata** ("Test now" per control) and confirm green.

## 5. What I need from you to proceed past the safe set
- 🟡 **B1**: OK to delete the 15 empty regional default VPCs?
- 🔴 **B2/B3**: OK to add NACL deny for 22/3389 and to remove port-80-from-world on the ALB SGs (or keep 80 for redirect + risk-accept)?
- 🟡 **A16**: OK to detach direct IAM policies and re-grant via groups (no permission change)?
- **C8 / C13 / A13**: decide scope-down vs risk-accept (least-privilege admins, ECS autoscaling, no-Lambda).
- **C3–C6**: want me to set GitHub org 2FA + `main` branch protection via `gh`?
