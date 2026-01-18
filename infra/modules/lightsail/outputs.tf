output "instance_id" {
  description = "ID of the Lightsail instance"
  value       = aws_lightsail_instance.this.id
}

output "instance_name" {
  description = "Name of the Lightsail instance"
  value       = aws_lightsail_instance.this.name
}

output "public_ip" {
  description = "Public IP address of the instance"
  value       = aws_lightsail_instance.this.public_ip_address
}

output "static_ip" {
  description = "Static IP address (if created or existing)"
  value       = var.create_static_ip ? (
    var.static_ip_name != null ? null : aws_lightsail_static_ip.this[0].ip_address
  ) : null
}

output "static_ip_name" {
  description = "Name of the static IP (created or existing)"
  value       = var.create_static_ip ? local.static_ip_name : null
}
