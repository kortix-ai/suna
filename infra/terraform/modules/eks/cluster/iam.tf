# ── Cluster + node IAM and the IRSA OIDC provider ─────────────────────────────
# Three pieces: the role the EKS control plane assumes, the role the worker
# nodes run as, and the IAM OIDC provider that lets in-cluster ServiceAccounts
# assume IAM roles (IRSA) — the mechanism External Secrets / ALB controller /
# the app use to reach AWS APIs without static keys.

# ── Control-plane role ────────────────────────────────────────────────────────
data "aws_iam_policy_document" "cluster_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cluster" {
  name               = "${var.name}-cluster"
  assume_role_policy = data.aws_iam_policy_document.cluster_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "cluster" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

# Allow the control plane to use the Secrets envelope-encryption CMK
# (aws_kms_key.eks_secrets in main.tf). EKS calls KMS as the cluster role.
resource "aws_iam_role_policy" "cluster_kms_secrets" {
  name = "${var.name}-cluster-kms-secrets"
  role = aws_iam_role.cluster.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kms:Encrypt", "kms:Decrypt", "kms:DescribeKey", "kms:CreateGrant"]
      Resource = aws_kms_key.eks_secrets.arn
    }]
  })
}

# ── Node role (managed node group EC2 instances) ──────────────────────────────
data "aws_iam_policy_document" "node_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "node" {
  name               = "${var.name}-node"
  assume_role_policy = data.aws_iam_policy_document.node_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "node" {
  for_each = toset([
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
    # SSM Session Manager: shell into a node for debugging without SSH/keys.
    "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
  ])
  role       = aws_iam_role.node.name
  policy_arn = each.value
}

# ── IRSA OIDC provider ────────────────────────────────────────────────────────
# The cluster issues OIDC tokens to pods; this provider lets IAM trust them so a
# ServiceAccount can assume a scoped role (used by every controller + the app).
data "tls_certificate" "oidc" {
  url = aws_eks_cluster.this.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "this" {
  url             = aws_eks_cluster.this.identity[0].oidc[0].issuer
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.oidc.certificates[0].sha1_fingerprint]
  tags            = var.tags
}
