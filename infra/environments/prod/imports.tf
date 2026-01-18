# Lightsail
import {
  to = module.lightsail.aws_lightsail_instance.this
  id = "suna-prod"
}

# Static IP doesn't support import - using existing StaticIp-2
# Attachment already exists, Terraform will detect it

# VPC
import {
  to = module.vpc.aws_vpc.this
  id = "vpc-059429b1482bcb4a2"
}

import {
  to = module.vpc.aws_internet_gateway.this
  id = "igw-08bb55e0b0f4a400b"
}

# Public Subnets
import {
  to = module.vpc.aws_subnet.public[0]
  id = "subnet-048079b0d4b0cd1df"
}

import {
  to = module.vpc.aws_subnet.public[1]
  id = "subnet-07eb84400f296dc6c"
}

import {
  to = module.vpc.aws_subnet.public[2]
  id = "subnet-0dff21dd37bef46e0"
}

# Private Subnets
import {
  to = module.vpc.aws_subnet.private[0]
  id = "subnet-050b82fe4bd582da8"
}

import {
  to = module.vpc.aws_subnet.private[1]
  id = "subnet-04d2ad7a0897103d4"
}

import {
  to = module.vpc.aws_subnet.private[2]
  id = "subnet-045eb85b5bfc4e0c1"
}

# NAT Gateways and EIPs
import {
  to = module.vpc.aws_eip.nat[0]
  id = "eipalloc-047838211dab8b0d9"
}

import {
  to = module.vpc.aws_eip.nat[1]
  id = "eipalloc-03eb6fdd9dd26a81e"
}

import {
  to = module.vpc.aws_eip.nat[2]
  id = "eipalloc-085d82e613129465d"
}

import {
  to = module.vpc.aws_nat_gateway.this[0]
  id = "nat-05dec7ddb520f8ef1"
}

import {
  to = module.vpc.aws_nat_gateway.this[1]
  id = "nat-07198ef973a7b458b"
}

import {
  to = module.vpc.aws_nat_gateway.this[2]
  id = "nat-005beb4356de283a4"
}

# Route Tables
import {
  to = module.vpc.aws_route_table.public
  id = "rtb-0d0588e73ece4fee0"
}

import {
  to = module.vpc.aws_route_table.private[0]
  id = "rtb-05625663487292be3"
}

import {
  to = module.vpc.aws_route_table.private[1]
  id = "rtb-0af4fec5ad6f28d50"
}

import {
  to = module.vpc.aws_route_table.private[2]
  id = "rtb-03d8fdf446c68ecaa"
}

# Route Table Associations (public)
import {
  to = module.vpc.aws_route_table_association.public[0]
  id = "subnet-048079b0d4b0cd1df/rtb-0d0588e73ece4fee0"
}

import {
  to = module.vpc.aws_route_table_association.public[1]
  id = "subnet-07eb84400f296dc6c/rtb-0d0588e73ece4fee0"
}

import {
  to = module.vpc.aws_route_table_association.public[2]
  id = "subnet-0dff21dd37bef46e0/rtb-0d0588e73ece4fee0"
}

# Route Table Associations (private)
import {
  to = module.vpc.aws_route_table_association.private[0]
  id = "subnet-050b82fe4bd582da8/rtb-05625663487292be3"
}

import {
  to = module.vpc.aws_route_table_association.private[1]
  id = "subnet-04d2ad7a0897103d4/rtb-0af4fec5ad6f28d50"
}

import {
  to = module.vpc.aws_route_table_association.private[2]
  id = "subnet-045eb85b5bfc4e0c1/rtb-03d8fdf446c68ecaa"
}

# Security Groups
import {
  to = module.vpc.aws_security_group.alb
  id = "sg-05781b733fe85aa05"
}

import {
  to = module.vpc.aws_security_group.ecs_tasks
  id = "sg-01452dafd65486ab5"
}

# Redis Security Group - VPC endpoints attached, using prevent_destroy
import {
  to = module.vpc.aws_security_group.redis[0]
  id = "sg-04d4716ff11efa835"
}

# ALB
import {
  to = module.alb.aws_lb.this
  id = "arn:aws:elasticloadbalancing:us-west-2:935064898258:loadbalancer/app/suna-alb-3975a7d/7561e782b30fc489"
}

import {
  to = module.alb.aws_lb_target_group.api
  id = "arn:aws:elasticloadbalancing:us-west-2:935064898258:targetgroup/suna-api-tg-2ca3a58/6128555cf310c98a"
}

import {
  to = module.alb.aws_lb_listener.http
  id = "arn:aws:elasticloadbalancing:us-west-2:935064898258:listener/app/suna-alb-3975a7d/7561e782b30fc489/ce7380a862c2a30b"
}

import {
  to = module.alb.aws_lb_listener.https
  id = "arn:aws:elasticloadbalancing:us-west-2:935064898258:listener/app/suna-alb-3975a7d/7561e782b30fc489/4d1619e10b357feb"
}

# S3 Bucket for ALB Logs (using the active one)
import {
  to = module.alb.aws_s3_bucket.alb_logs
  id = "suna-alb-logs-fc5d290"
}

# ECS
import {
  to = module.ecs.aws_ecs_cluster.this
  id = "suna-ecs"
}

# ECS Service - service exists but is INACTIVE, may need to be recreated
# import {
#   to = module.ecs.aws_ecs_service.api
#   id = "suna-ecs/suna-api-svc-6a0ece6"
# }

# Autoscaling Group was destroyed - will be recreated
# import {
#   to = module.ecs.aws_autoscaling_group.this
#   id = "suna-ecs-asg-092e94f"
# }

# Capacity Provider was destroyed - will be recreated
# import {
#   to = module.ecs.aws_ecs_capacity_provider.this
#   id = "suna-capacity-625da4b"
# }

# CloudWatch log groups - using existing one
# Note: There are two existing log groups (/ecs/suna-api-e74cd53, /ecs/suna-api-f4ebf11)
# Terraform will create /ecs/suna-api - this is fine, we'll consolidate later

# Cloudflare
import {
  to = module.tunnel_lightsail.cloudflare_tunnel.this
  id = "9785405a992435bb0c7bd19f9b6d26d5/f4125d84-33d5-424d-ae6b-2b84b790392b"
}

import {
  to = module.worker.cloudflare_worker_script.router
  id = "9785405a992435bb0c7bd19f9b6d26d5/api-kortix-router"
}

import {
  to = module.worker.cloudflare_worker_domain.api
  id = "9785405a992435bb0c7bd19f9b6d26d5/4598846a174f17ae85fb60daed3fb651880c5baf"
}

# Import existing DNS records
import {
  to = module.dns.cloudflare_record.this["api-ecs"]
  id = "af378d3df4e4dd5052a1fcbf263b685d/3e225e148e415503c09971f8b3058219"
}

import {
  to = module.dns.cloudflare_record.this["api-lightsail"]
  id = "af378d3df4e4dd5052a1fcbf263b685d/30b3f1185986f457e474de736818f924"
}
