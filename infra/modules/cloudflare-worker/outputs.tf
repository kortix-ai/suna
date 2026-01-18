output "worker_id" {
  description = "ID of the Cloudflare Worker"
  value       = cloudflare_worker_script.router.id
}

output "worker_name" {
  description = "Name of the Cloudflare Worker"
  value       = cloudflare_worker_script.router.name
}

output "hostname" {
  description = "Hostname of the worker custom domain"
  value       = cloudflare_worker_domain.api.hostname
}
