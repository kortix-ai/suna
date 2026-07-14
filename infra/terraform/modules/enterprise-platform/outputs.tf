output "app_namespace" { value = kubernetes_namespace.app.metadata[0].name }
output "app_service_account" { value = kubernetes_service_account.app.metadata[0].name }
