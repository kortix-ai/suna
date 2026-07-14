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
