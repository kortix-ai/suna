export interface LightsailConfig {
  name: string;
  environment: string;
  availabilityZone: string;
  blueprintId: string;
  bundleId: string;
  keyPairName: string;
  tunnelId: string;
  apiEndpoint: string;
  tags?: Record<string, string>;
}
