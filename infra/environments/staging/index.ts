import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import { COMMON_TAGS } from "../../components";

// ============================================================================
// LIGHTSAIL INSTANCE (Imported from existing)
// ============================================================================

const instance = new aws.lightsail.Instance("suna-staging-instance", {
  name: "suna-staging",
  availabilityZone: "us-west-2a",
  blueprintId: "ubuntu_24_04",
  bundleId: "large_3_0",
  keyPairName: "suna-staging-key",
  tags: {
    ...COMMON_TAGS,
    Environment: "staging",
    Name: "suna-staging",
  },
});

const ports = new aws.lightsail.InstancePublicPorts("suna-staging-ports", {
  instanceName: instance.name,
  portInfos: [{
    protocol: "tcp",
    fromPort: 22,
    toPort: 22,
    cidrs: ["0.0.0.0/0"],
  }],
});

// ============================================================================
// CLOUDFLARE (Existing - not managed by Pulumi)
// ============================================================================

// Tunnel and DNS records are already configured in Cloudflare
const EXISTING_TUNNEL_ID = "503813f5-2426-401a-b72f-15bd11d4b4ba";

// ============================================================================
// EXPORTS
// ============================================================================

export const environment = "staging";
export const instanceName = instance.name;
export const publicIpAddress = instance.publicIpAddress;
export const privateIpAddress = instance.privateIpAddress;

export const tunnelId = EXISTING_TUNNEL_ID;
export const tunnelCname = `${EXISTING_TUNNEL_ID}.cfargotunnel.com`;

export const apiEndpoints = {
  kortix: "staging-api.kortix.com",
  suna: "staging-api.suna.so",
};

// Setup instructions
export const setupInstructions = pulumi.interpolate`
=== STAGING ENVIRONMENT SETUP ===

1. SSH into the instance:
   ssh -i suna-staging-key.pem ubuntu@${instance.publicIpAddress}

2. Check tunnel status:
   sudo systemctl status cloudflared

3. API endpoints:
   - https://staging-api.kortix.com
   - https://staging-api.suna.so
`;
