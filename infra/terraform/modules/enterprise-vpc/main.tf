data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

data "aws_ssm_parameter" "al2023_ami" {
  count = var.supabase_ami_id == null ? 1 : 0
  name  = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

locals {
  region       = data.aws_region.current.region
  partition    = data.aws_partition.current.partition
  supabase_ami = coalesce(var.supabase_ami_id, try(data.aws_ssm_parameter.al2023_ami[0].value, null))
  tags = merge(var.tags, {
    ManagedBy      = "terraform"
    Platform       = "kortix-enterprise"
    KortixInstance = var.name
    DataBoundary   = "customer-account"
  })
}

resource "terraform_data" "account_guard" {
  input = data.aws_caller_identity.current.account_id

  lifecycle {
    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.expected_account_id
      error_message = "AWS account mismatch: refusing to manage ${var.name} outside account ${var.expected_account_id}."
    }
    precondition {
      condition     = var.node_min_size >= 3 && var.node_desired_size >= 3 && var.node_max_size >= var.node_desired_size
      error_message = "Enterprise EKS requires a three-node minimum and a coherent autoscaling range."
    }
  }
}
