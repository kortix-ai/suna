variable "cluster_name" {
  description = "Name of the ECS cluster"
  type        = string
  default     = "suna-ecs"
}

variable "instance_type" {
  description = "EC2 instance type for ECS capacity"
  type        = string
  default     = "r6a.xlarge"
}

variable "key_name" {
  description = "EC2 key pair name"
  type        = string
  default     = ""
}

variable "vpc_id" {
  description = "ID of the VPC"
  type        = string
}

variable "private_subnet_ids" {
  description = "IDs of private subnets for ECS tasks"
  type        = list(string)
}

variable "ecs_security_group_id" {
  description = "ID of the ECS tasks security group"
  type        = string
}

variable "target_group_arn" {
  description = "ARN of the ALB target group"
  type        = string
}

variable "min_size" {
  description = "Minimum number of instances in ASG"
  type        = number
  default     = 2
}

variable "max_size" {
  description = "Maximum number of instances in ASG"
  type        = number
  default     = 8
}

variable "desired_capacity" {
  description = "Desired number of instances in ASG"
  type        = number
  default     = 2
}

variable "service_desired_count" {
  description = "Desired number of ECS tasks"
  type        = number
  default     = 4
}

variable "service_base_count" {
  description = "Base number of tasks (always running)"
  type        = number
  default     = 2
}

variable "task_cpu" {
  description = "CPU units for task (1024 = 1 vCPU)"
  type        = number
  default     = 2048
}

variable "task_memory" {
  description = "Memory for task in MB"
  type        = number
  default     = 8192
}

variable "container_image" {
  description = "Container image to use"
  type        = string
  default     = "ghcr.io/kortix-ai/suna/suna-backend:prod"
}

variable "use_aws_redis" {
  description = "Whether to use AWS Redis (set env vars)"
  type        = bool
  default     = false
}

variable "redis_endpoint" {
  description = "Redis endpoint (if using AWS Redis)"
  type        = string
  default     = ""
}

variable "secrets_arn" {
  description = "ARN of Secrets Manager secret for environment variables"
  type        = string
  default     = null
}

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default = {
    "map-migrated" = "migDTKWJGT6A7"
  }
}
