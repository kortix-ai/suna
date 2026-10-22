---
recorded: 2026-10-13T14:46:38Z
incident_date: 2026-10-12
---
# Give every new VPC its flow log and an empty default security group in the PR that creates it

**Rule:** When a PR creates a VPC (a new `environments/*` root or a region move through `modules/network`), add in the same PR an `aws_flow_log` to the regional `/vpc/flowlogs` group and an `aws_default_security_group` with `ingress = []` and `egress = []` for that VPC. `modules/network` creates neither on purpose. When a PR deletes a VPC, move these two controls to the VPC that replaces it; do not delete them.

**Trigger surface:** Moving an environment to another region, creating a VPC with `modules/network`, or deleting a stack whose root held the account's only `aws_default_security_group` or `aws_flow_log`.

**Incident:** 2026-10-06 the dev (us-east-2, #9230) and staging (eu-west-2, #9254) VPCs moved to new regions with the AWS default security group (all traffic from the group, all egress) and no flow log. The only `aws_default_security_group` in Terraform targeted the us-east-2 prod shadow VPC; #9675 removed it with that VPC on 2026-10-12. Drata test 224 (VPC Flow Logging) failed on 4 VPCs and test 233 (default SG restricts all traffic) on 2, inside the SOC 2 Type 2 observation window. 2026-10-12 added the flow logs; 2026-10-13 added the default security groups in `compliance-monitoring` (0 ENIs used either group).

**Enforcement:** Drata tests 224 and 233 re-run daily and fail on any VPC without them. none yet in the repo: build a `tests/unit` check that every `data "aws_vpc"` or `module "network"` an environment root uses has a matching `aws_flow_log` and `aws_default_security_group` in `compliance-monitoring`.
