# Import existing Lightsail instance
import {
  to = module.lightsail.aws_lightsail_instance.this
  id = "suna-dev"
}

# Import existing Cloudflare tunnel
import {
  to = module.tunnel.cloudflare_tunnel.this
  id = "9785405a992435bb0c7bd19f9b6d26d5/3a533a53-67d0-487c-b716-261c863270ee"
}

# Import existing DNS record
import {
  to = module.dns.cloudflare_record.this["dev-api"]
  id = "af378d3df4e4dd5052a1fcbf263b685d/328d32acbb8986387cdb0941e89a8e73"
}
