variable "instance_name" {
  description = "Lightsail instance name (also used to name related resources)."
  type        = string
}

variable "availability_zone" {
  description = "Lightsail AZ, e.g. us-west-2a."
  type        = string
}

variable "blueprint_id" {
  description = "Lightsail OS blueprint."
  type        = string
  default     = "ubuntu_24_04"
}

variable "bundle_id" {
  description = "Lightsail bundle (instance size), e.g. small_3_0, large_3_0, xlarge_3_0."
  type        = string
}

variable "key_pair_name" {
  description = "Lightsail SSH key pair name attached to the instance."
  type        = string
  default     = "LightsailDefaultKeyPair"
}

variable "static_ip_name" {
  description = "Name of the Lightsail static IP attached to the instance."
  type        = string
}

variable "open_ports" {
  description = "Firewall ports to open on the instance."
  type = list(object({
    from_port = number
    to_port   = number
    protocol  = string
  }))
  default = [
    { from_port = 22, to_port = 22, protocol = "tcp" },     # ssh (deploy)
    { from_port = 80, to_port = 80, protocol = "tcp" },     # http (acme/redirect)
    { from_port = 443, to_port = 443, protocol = "tcp" },   # https (nginx → cf origin)
    { from_port = 8008, to_port = 8009, protocol = "tcp" }, # blue/green api upstreams
  ]
}

variable "tags" {
  description = "Tags applied to taggable resources."
  type        = map(string)
  default     = {}
}
