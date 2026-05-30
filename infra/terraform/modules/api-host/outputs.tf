output "instance_name" {
  value = aws_lightsail_instance.this.name
}

output "public_ip" {
  description = "Static public IP attached to the instance (DNS target)."
  value       = aws_lightsail_static_ip.this.ip_address
}

output "private_ip" {
  value = aws_lightsail_instance.this.private_ip_address
}

output "availability_zone" {
  value = aws_lightsail_instance.this.availability_zone
}
