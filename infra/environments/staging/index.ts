import { COMMON_TAGS } from "../../modules/constants";
import { LightsailInstance } from "../../modules/lightsail";

const lightsail = new LightsailInstance("suna-staging", {
  name: "suna-staging",
  environment: "staging",
  availabilityZone: "us-west-2a",
  blueprintId: "ubuntu_24_04",
  bundleId: "large_3_0",
  keyPairName: "suna-staging-key",
  tunnelId: "503813f5-2426-401a-b72f-15bd11d4b4ba",
  apiEndpoint: "staging-api.kortix.com",
  tags: COMMON_TAGS,
});

export const environment = "staging";
export const instanceName = lightsail.instanceName;
export const publicIpAddress = lightsail.publicIpAddress;
export const privateIpAddress = lightsail.privateIpAddress;

export const tunnelId = "503813f5-2426-401a-b72f-15bd11d4b4ba";
export const tunnelCname = `${tunnelId}.cfargotunnel.com`;

export const apiEndpoints = {
  kortix: "staging-api.kortix.com",
};
