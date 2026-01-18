# Import existing Lightsail instance
import {
  to = module.lightsail.aws_lightsail_instance.this
  id = "suna-staging"
}

# Static IP doesn't support import - it's already attached to the instance
# Terraform will detect the attachment when reading the instance state
# We'll manage it going forward but won't import the existing one

# Import existing Cloudflare tunnel
import {
  to = module.tunnel.cloudflare_tunnel.this
  id = "9785405a992435bb0c7bd19f9b6d26d5/503813f5-2426-401a-b72f-15bd11d4b4ba"
}

# Import existing DNS records
import {
  to = module.dns_kortix.cloudflare_record.this["staging-api-kortix"]
  id = "af378d3df4e4dd5052a1fcbf263b685d/439e0ab0cd5179670228dae0ea58ce8e"
}

import {
  to = module.dns_suna.cloudflare_record.this["staging-api-suna"]
  id = "cb0c8537f735d98fbbed1ae142f94fbe/c098d5f70934795c76b7b3afddb6aa63"
}
