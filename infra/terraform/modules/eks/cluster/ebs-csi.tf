# EBS CSI driver — REQUIRED for any PersistentVolume. EKS 1.32 dropped the in-tree
# aws-ebs provisioner, so without this addon the cluster can provision no storage
# (Prometheus/Grafana/Loki/Velero PVCs hang Pending). IRSA-scoped to the managed
# AmazonEBSCSIDriverPolicy. A default gp3 StorageClass is created so PVCs that omit
# storageClassName bind.

data "aws_iam_policy_document" "ebs_csi_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    effect  = "Allow"
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.this.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${replace(aws_iam_openid_connect_provider.this.url, "https://", "")}:sub"
      values   = ["system:serviceaccount:kube-system:ebs-csi-controller-sa"]
    }
    condition {
      test     = "StringEquals"
      variable = "${replace(aws_iam_openid_connect_provider.this.url, "https://", "")}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ebs_csi" {
  name                 = "${aws_eks_cluster.this.name}-ebs-csi-driver"
  assume_role_policy   = data.aws_iam_policy_document.ebs_csi_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = merge({ ManagedBy = "terraform" }, var.tags)
}

resource "aws_iam_role_policy_attachment" "ebs_csi" {
  role       = aws_iam_role.ebs_csi.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"
}

resource "aws_eks_addon" "ebs_csi" {
  cluster_name                = aws_eks_cluster.this.name
  addon_name                  = "aws-ebs-csi-driver"
  service_account_role_arn    = aws_iam_role.ebs_csi.arn
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "PRESERVE"
  tags                        = merge({ ManagedBy = "terraform" }, var.tags)

  depends_on = [aws_eks_node_group.this]
}
