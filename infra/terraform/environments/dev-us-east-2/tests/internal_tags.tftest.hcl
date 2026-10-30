mock_provider "aws" {}
mock_provider "cloudflare" {}

run "internal_security_group_inventory_tags" {
  command = plan

  plan_options {
    target = [aws_security_group.api_internal, aws_security_group.gateway_internal]
  }

  assert {
    condition = aws_security_group.api_internal.tags == tomap({
      Name        = "kortix-dev-use2-api-internal"
      Environment = "dev"
      Region      = "us-east-2"
      Service     = "kortix-api"
      ManagedBy   = "terraform"
    })
    error_message = "The internal API security group must retain its inventory tags and carry its resource name."
  }

  assert {
    condition = aws_security_group.gateway_internal.tags == tomap({
      Name        = "kortix-dev-use2-gateway-internal"
      Environment = "dev"
      Region      = "us-east-2"
      Service     = "kortix-api"
      ManagedBy   = "terraform"
    })
    error_message = "The internal gateway security group must retain its inventory tags and carry its resource name."
  }
}
