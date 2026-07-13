resource "aws_default_security_group" "default" {
  vpc_id  = module.network.vpc_id
  ingress = []
  egress  = []
  tags    = merge(local.tags, { Name = "${var.name}-default-deny" })
}
resource "aws_cloudwatch_log_group" "vpc_flow" {
  name              = "/kortix/${var.name}/vpc-flow"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.data.arn
  tags              = local.tags
}

data "aws_iam_policy_document" "flow_logs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["vpc-flow-logs.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "flow_logs" {
  name                 = "${var.name}-vpc-flow-logs"
  assume_role_policy   = data.aws_iam_policy_document.flow_logs_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.tags
}

resource "aws_iam_role_policy" "flow_logs" {
  name = "${var.name}-vpc-flow-logs"
  role = aws_iam_role.flow_logs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:DescribeLogGroups",
          "logs:DescribeLogStreams",
          "logs:PutLogEvents",
        ]
        Resource = "${aws_cloudwatch_log_group.vpc_flow.arn}:*"
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Encrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
        Resource = aws_kms_key.data.arn
      },
    ]
  })
}

resource "aws_flow_log" "vpc" {
  vpc_id                   = module.network.vpc_id
  traffic_type             = "ALL"
  log_destination_type     = "cloud-watch-logs"
  log_destination          = aws_cloudwatch_log_group.vpc_flow.arn
  iam_role_arn             = aws_iam_role.flow_logs.arn
  max_aggregation_interval = 60
  tags                     = local.tags
}
