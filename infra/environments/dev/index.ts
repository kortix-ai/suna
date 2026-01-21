import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import { COMMON_TAGS } from "../../components";

// ============================================================================
// LIGHTSAIL INSTANCE (Imported from existing)
// ============================================================================

const instance = new aws.lightsail.Instance("suna-dev-instance", {
  name: "suna-dev",
  availabilityZone: "us-west-2a",
  blueprintId: "ubuntu_24_04",
  bundleId: "large_3_0",
  keyPairName: "kortix-lightsail",
  tags: {
    ...COMMON_TAGS,
    Environment: "dev",
    Name: "suna-dev",
  },
});

const ports = new aws.lightsail.InstancePublicPorts("suna-dev-ports", {
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
const EXISTING_TUNNEL_ID = "3a533a53-67d0-487c-b716-261c863270ee";

// ============================================================================
// EXPORTS
// ============================================================================

export const environment = "dev";
export const instanceName = instance.name;
export const publicIpAddress = instance.publicIpAddress;
export const privateIpAddress = instance.privateIpAddress;

export const tunnelId = EXISTING_TUNNEL_ID;
export const tunnelCname = `${EXISTING_TUNNEL_ID}.cfargotunnel.com`;

export const apiEndpoint = "dev-api.kortix.com";

// Setup instructions
export const setupInstructions = pulumi.interpolate`
=== DEV ENVIRONMENT SETUP ===

1. SSH into the instance:
   ssh ubuntu@${instance.publicIpAddress}

2. Check tunnel status:
   sudo systemctl status cloudflared

3. API endpoint: https://dev-api.kortix.com
`;
