# __generated__ by Terraform
# Please review these resources and move them into your main configuration files.

# __generated__ by Terraform from "whatsapp-gateway-github-deploy"
resource "aws_iam_role" "whatsapp_gateway_github_deploy" {
  assume_role_policy    = "{\"Statement\":[{\"Action\":\"sts:AssumeRoleWithWebIdentity\",\"Condition\":{\"StringEquals\":{\"token.actions.githubusercontent.com:aud\":\"sts.amazonaws.com\",\"token.actions.githubusercontent.com:sub\":[\"repo:kortix-ai/whatsapp-gateway:ref:refs/heads/main\",\"repo:kortix-ai@170767358/whatsapp-gateway@1307148265:ref:refs/heads/main\"]}},\"Effect\":\"Allow\",\"Principal\":{\"Federated\":\"arn:aws:iam::935064898258:oidc-provider/token.actions.githubusercontent.com\"}}],\"Version\":\"2012-10-17\"}"
  description           = null
  force_detach_policies = false
  max_session_duration  = 3600
  name                  = "whatsapp-gateway-github-deploy"
  name_prefix           = null
  path                  = "/"
  permissions_boundary  = null
  tags                  = {}
  tags_all              = {}
}

# __generated__ by Terraform from "bedrock-logs"
resource "aws_iam_role" "bedrock_logs" {
  assume_role_policy    = "{\"Statement\":[{\"Action\":\"sts:AssumeRole\",\"Condition\":{\"ArnLike\":{\"aws:SourceArn\":\"arn:aws:bedrock:us-west-2:935064898258:*\"},\"StringEquals\":{\"aws:SourceAccount\":\"935064898258\"}},\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"bedrock.amazonaws.com\"},\"Sid\":\"AmazonBedrockModelInvocationCWDeliveryRole\"}],\"Version\":\"2012-10-17\"}"
  description           = "Bedrock Access to CloudWatch Log Group"
  force_detach_policies = false
  max_session_duration  = 3600
  name                  = "bedrock-logs"
  name_prefix           = null
  path                  = "/service-role/"
  permissions_boundary  = null
  tags                  = {}
  tags_all              = {}
}

# __generated__ by Terraform from "whatsapp-gateway-instance"
resource "aws_iam_role" "whatsapp_gateway_instance" {
  assume_role_policy    = "{\"Statement\":[{\"Action\":\"sts:AssumeRole\",\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"ec2.amazonaws.com\"}}],\"Version\":\"2012-10-17\"}"
  description           = null
  force_detach_policies = false
  max_session_duration  = 3600
  name                  = "whatsapp-gateway-instance"
  name_prefix           = null
  path                  = "/"
  permissions_boundary  = null
  tags                  = {}
  tags_all              = {}
}
