import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import { COMMON_TAGS } from "../../components";

// ============================================================================
// LIGHTSAIL INSTANCE (Imported from existing)
// ============================================================================

const instance = new aws.lightsail.Instance("suna-prod-instance", {
  name: "suna-prod",
  availabilityZone: "us-west-2a",
  blueprintId: "ubuntu_24_04",
  bundleId: "8xlarge_3_0",
  keyPairName: "suna-prod-key",
  tags: {
    ...COMMON_TAGS,
    Environment: "prod",
    Name: "suna-prod",
  },
});

const ports = new aws.lightsail.InstancePublicPorts("suna-prod-ports", {
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
const EXISTING_TUNNEL_ID = "f4125d84-33d5-424d-ae6b-2b84b790392b";

// ============================================================================
// ECS (Existing - not managed by Pulumi)
// ============================================================================

// ECS cluster and related resources are already configured in AWS
const ECS_CLUSTER_NAME = "suna-ecs";
const ALB_DNS_NAME = "suna-alb-3975a7d-1271164322.us-west-2.elb.amazonaws.com";

// ============================================================================
// EXPORTS
// ============================================================================

export const environment = "prod";
export const instanceName = instance.name;
export const publicIpAddress = instance.publicIpAddress;
export const privateIpAddress = instance.privateIpAddress;

export const tunnelId = EXISTING_TUNNEL_ID;
export const tunnelCname = `${EXISTING_TUNNEL_ID}.cfargotunnel.com`;

export const ecsClusterName = ECS_CLUSTER_NAME;
export const albDnsName = ALB_DNS_NAME;

export const apiEndpoints = {
  primary: "api.kortix.com",
  lightsail: "api-lightsail.kortix.com",
  ecs: "api-ecs.kortix.com",
};

// Setup instructions
export const setupInstructions = pulumi.interpolate`
=== PRODUCTION ENVIRONMENT SETUP ===

1. SSH into Lightsail instance:
   ssh ubuntu@${instance.publicIpAddress}

2. Check tunnel status:
   sudo systemctl status cloudflared

3. API endpoints:
   - Primary (routed via Cloudflare Worker): https://api.kortix.com
   - Lightsail direct: https://api-lightsail.kortix.com
   - ECS direct: https://api-ecs.kortix.com

4. ECS cluster: ${ECS_CLUSTER_NAME}
   ALB: ${ALB_DNS_NAME}
`;
