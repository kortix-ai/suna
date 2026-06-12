variable "cloudflare_api_token" {
  description = <<-EOT
    Cloudflare API token external-dns uses to manage the api-eks.kortix.com
    record on the kortix.com zone (DNS:Edit). Supply via
    TF_VAR_cloudflare_api_token. Everything else is read from the cluster layer's
    remote state.
  EOT
  type        = string
  sensitive   = true
}
