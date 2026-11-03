output "vpc_id" {
  value = aws_vpc.this.id
}

output "public_subnet_ids" {
  description = "Public subnet IDs (host the ALB)."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "Private subnet IDs (host the Fargate tasks / EKS nodes)."
  value       = aws_subnet.private[*].id
}

output "private_route_table_ids" {
  description = "Private route table IDs for gateway endpoints and tenant-local routes."
  value       = aws_route_table.private[*].id
}

output "vpc_cidr" {
  value = aws_vpc.this.cidr_block
}

output "availability_zones" {
  value = local.azs
}

output "s3_gateway_endpoint_id" {
  description = "S3 gateway endpoint on the private route tables (S3 traffic skips the NAT)."
  value       = aws_vpc_endpoint.s3.id
}

output "egress_subnet_ids" {
  description = "Egress subnet IDs: tasks with a public IP reach the internet directly and GitHub through the NAT."
  value       = aws_subnet.egress[*].id
}

output "github_prefix_list_id" {
  description = "Managed prefix list of GitHub's IPv4 ranges, routed through the NAT from the egress subnets."
  value       = aws_ec2_managed_prefix_list.github.id
}
