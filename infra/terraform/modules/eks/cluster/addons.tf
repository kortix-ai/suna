# ── Core EKS managed add-ons ──────────────────────────────────────────────────
# vpc-cni (pod networking), kube-proxy (service routing), and CoreDNS (in-cluster
# DNS) are run as EKS-managed add-ons so AWS keeps them patched and
# version-compatible with the control plane. Versions are omitted so EKS selects
# the default compatible with var.cluster_version; bump deliberately by pinning
# addon_version later if needed.
#
# CoreDNS runs as pods, so it must come up AFTER the node group exists — hence
# the depends_on. kube-proxy/vpc-cni are (also) fine to create early.

resource "aws_eks_addon" "vpc_cni" {
  cluster_name                = aws_eks_cluster.this.name
  addon_name                  = "vpc-cni"
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "PRESERVE"
  tags                        = var.tags
}

resource "aws_eks_addon" "kube_proxy" {
  cluster_name                = aws_eks_cluster.this.name
  addon_name                  = "kube-proxy"
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "PRESERVE"
  tags                        = var.tags
}

resource "aws_eks_addon" "coredns" {
  cluster_name                = aws_eks_cluster.this.name
  addon_name                  = "coredns"
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "PRESERVE"
  tags                        = var.tags

  depends_on = [aws_eks_node_group.this]
}
