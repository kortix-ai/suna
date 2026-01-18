variable "instance_name" {
  description = "Name of the Lightsail instance"
  type        = string
}

variable "availability_zone" {
  description = "Availability zone for the instance"
  type        = string
  default     = "us-west-2a"
}

variable "blueprint_id" {
  description = "Blueprint ID (OS image)"
  type        = string
  default     = "ubuntu_24_04"
}

variable "bundle_id" {
  description = "Bundle ID (instance size)"
  type        = string
}

variable "key_pair_name" {
  description = "Name of the key pair to use"
  type        = string
}

variable "create_static_ip" {
  description = "Whether to create and attach a static IP"
  type        = bool
  default     = false
}

variable "static_ip_name" {
  description = "Name of existing static IP to use (if not creating new one)"
  type        = string
  default     = null
}

variable "tags" {
  description = "Tags to apply to the instance"
  type        = map(string)
  default     = {}
}
