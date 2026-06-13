output "app_namespace" {
  value = kubernetes_namespace.app.metadata[0].name
}

output "controllers" {
  description = "Installed platform controllers + pinned chart versions."
  value       = module.platform.controllers
}
