import { COMMON_TAGS } from "../../modules/constants";
import { LightsailInstance } from "../../modules/lightsail";

const lightsail = new LightsailInstance("suna-dev", {
  name: "suna-dev",
  environment: "dev",
  availabilityZone: "us-west-2a",
  blueprintId: "ubuntu_24_04",
  bundleId: "large_3_0",
  keyPairName: "kortix-lightsail",
  tunnelId: "3a533a53-67d0-487c-b716-261c863270ee",
  apiEndpoint: "dev-api.kortix.com",
  tags: COMMON_TAGS,
});

export const environment = "dev";
export const instanceName = lightsail.instanceName;
export const publicIpAddress = lightsail.publicIpAddress;
export const privateIpAddress = lightsail.privateIpAddress;

export const tunnelId = "3a533a53-67d0-487c-b716-261c863270ee";
export const tunnelCname = `${tunnelId}.cfargotunnel.com`;

export const apiEndpoint = "dev-api.kortix.com";
