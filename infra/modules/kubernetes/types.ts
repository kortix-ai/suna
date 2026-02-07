import * as pulumi from "@pulumi/pulumi";

export interface EksClusterConfig {
  name: string;
  environment: string;
  version: string;
  vpcId: pulumi.Input<string>;
  privateSubnetIds: pulumi.Input<string>[];
  publicSubnetIds: pulumi.Input<string>[];
  tags?: Record<string, string>;
}

export interface NodeGroupConfig {
  name: string;
  instanceTypes: string[];
  capacityType: "ON_DEMAND" | "SPOT";
  scalingConfig: {
    minSize: number;
    maxSize: number;
    desiredSize: number;
  };
  labels?: Record<string, string>;
  taints?: {
    key: string;
    value: string;
    effect: "NO_SCHEDULE" | "NO_EXECUTE" | "PREFER_NO_SCHEDULE";
  }[];
  tags?: Record<string, string>;
}

export interface WorkloadConfig {
  name: string;
  namespace: string;
  image: string;
  port: number;
  replicas: number;
  cpu: { request: string; limit: string };
  memory: { request: string; limit: string };
  healthCheckPath: string;
  envSecretName: string;
  secretsArn: pulumi.Input<string>;
  workersPerPod: number;
  nodeSelector?: Record<string, string>;
  tolerations?: {
    key: string;
    operator: string;
    value?: string;
    effect: string;
  }[];
  hpa: {
    minReplicas: number;
    maxReplicas: number;
    cpuTargetPercent: number;
    memoryTargetPercent?: number;
  };
  ingress: {
    enabled: boolean;
    annotations?: Record<string, string>;
    host?: string;
  };
  tags?: Record<string, string>;
}
