# Automated weekly security patching for the EC2 worker fleet.
#
# The associations target stable EKS cluster tags rather than current instance
# IDs, so replacement and autoscaled nodes enter the patch schedule
# automatically. max_concurrency=1 keeps Kubernetes capacity available while a
# node installs packages and reboots. AWS-RunPatchBaseline records execution
# and compliance state in Systems Manager for audit sampling.

resource "aws_ssm_association" "dev_security_patches" {
  name             = "AWS-RunPatchBaseline"
  association_name = "kortix-dev-weekly-security-patches"

  schedule_expression         = "cron(0 4 ? * SUN *)"
  apply_only_at_cron_interval = true
  compliance_severity         = "HIGH"
  max_concurrency             = "1"
  max_errors                  = "0"

  parameters = {
    Operation    = "Install"
    RebootOption = "RebootIfNeeded"
  }

  targets {
    key    = "tag:eks:cluster-name"
    values = ["kortix-dev-eks"]
  }
}

resource "aws_ssm_association" "prod_security_patches" {
  provider = aws.euw2

  name             = "AWS-RunPatchBaseline"
  association_name = "kortix-prod-weekly-security-patches"

  schedule_expression         = "cron(0 5 ? * SUN *)"
  apply_only_at_cron_interval = true
  compliance_severity         = "HIGH"
  max_concurrency             = "1"
  max_errors                  = "0"

  parameters = {
    Operation    = "Install"
    RebootOption = "RebootIfNeeded"
  }

  targets {
    key    = "tag:eks:cluster-name"
    values = ["kortix-prod-eks"]
  }
}
