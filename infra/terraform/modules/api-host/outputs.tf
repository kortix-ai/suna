output "instance_name" {
  value = aws_lightsail_instance.this.name
}

output "public_ip" {
  description = "Public IP (DNS target): the managed static IP if any, else the instance's public IP."
  value       = var.manage_static_ip ? aws_lightsail_static_ip.this[0].ip_address : aws_lightsail_instance.this.public_ip_address
}

output "private_ip" {
  value = aws_lightsail_instance.this.private_ip_address
}

output "availability_zone" {
  value = aws_lightsail_instance.this.availability_zone
}
