# Reusable EKS control plane + a managed node group, tuned for production uptime
# and self-healing. Mirrors the spirit of modules/ecs-api (a self-contained,
# parameterised compute substrate) but for Kubernetes:
#
#   - Control plane: AWS-managed, multi-AZ (99.95% SLA), full audit logging on.
#   - Nodes: managed node group, on-demand, spread across the AZs of the private
#     subnets, with NODE AUTO-REPAIR so EKS replaces an unhealthy EC2 node on its
#     own — the node-level half of the auto-healing story (the pod-level half is
#     liveness/readiness probes in the app chart).
#   - API authentication mode = API (access entries, no aws-auth configmap), so
#     access is managed in IAM/Terraform, not an in-cluster ConfigMap.
#
# The in-cluster controllers (ALB, External Secrets, external-dns,
# cluster-autoscaler, metrics-server) live in modules/eks/platform, applied
# against this cluster afterward.

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.79" # node_repair_config (managed node group auto-repair)
    }
    tls = {
      source  = "hashicorp/tls"
      version = ">= 4.0"
    }
  }
}

resource "aws_eks_cluster" "this" {
  #checkov:skip=CKV_AWS_38:Public endpoint exposure is caller-controlled; enterprise-vpc explicitly disables it and supplies no public CIDRs.
  #checkov:skip=CKV_AWS_39:This reusable module supports legacy public clusters; the enterprise root sets endpoint_public_access=false.
  #checkov:skip=CKV_AWS_58:Encryption is a caller-supplied KMS key; enterprise-vpc always passes its customer-owned data key.
  name     = var.name
  role_arn = aws_iam_role.cluster.arn
  version  = var.cluster_version

  vpc_config {
    subnet_ids              = var.control_plane_subnet_ids
    endpoint_private_access = true
    endpoint_public_access  = var.endpoint_public_access
    public_access_cidrs     = var.endpoint_public_access_cidrs
  }

  access_config {
    authentication_mode                         = "API"
    bootstrap_cluster_creator_admin_permissions = var.bootstrap_cluster_creator_admin_permissions
  }

  # Ship control-plane logs to CloudWatch for audit/forensics (SOC 2).
  enabled_cluster_log_types = var.cluster_log_types

  dynamic "encryption_config" {
    for_each = var.secrets_encryption_kms_key_arn == null ? [] : [var.secrets_encryption_kms_key_arn]
    content {
      provider {
        key_arn = encryption_config.value
      }
      resources = ["secrets"]
    }
  }

  tags = merge({ ManagedBy = "terraform" }, var.tags)

  depends_on = [aws_iam_role_policy_attachment.cluster]
}

# ── Managed node group ────────────────────────────────────────────────────────
resource "aws_eks_node_group" "this" {
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = "${var.name}-ng"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = var.node_subnet_ids

  # On-demand for prod stability (no spot interruptions on the API tier).
  capacity_type  = var.node_capacity_type
  instance_types = var.node_instance_types
  disk_size      = var.node_disk_size

  scaling_config {
    desired_size = var.node_desired_size
    min_size     = var.node_min_size
    max_size     = var.node_max_size
  }

  # Surge upgrades: never take more than this % of the group down at once when
  # rolling a new AMI, so node patching is non-disruptive.
  update_config {
    max_unavailable_percentage = var.node_max_unavailable_percentage
  }

  # Auto-heal: EKS detects an unhealthy node (failed kubelet, stuck, NotReady)
  # and replaces it automatically.
  node_repair_config {
    enabled = var.enable_node_auto_repair
  }

  labels = merge({ "workload" = "kortix-api" }, var.node_labels)
  tags   = merge({ ManagedBy = "terraform" }, var.tags)

  # Replacing the launch config (instance types, disk) recreates nodes; let the
  # new group come up before the old is torn down.
  lifecycle {
    create_before_destroy = true
    # desired_size is owned by the cluster-autoscaler at runtime — don't fight it.
    ignore_changes = [scaling_config[0].desired_size]
  }

  depends_on = [aws_iam_role_policy_attachment.node]
}
