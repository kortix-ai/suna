import * as pulumi from "@pulumi/pulumi";

export interface EcsClusterConfig {
  name: string;
  environment: string;
  containerInsights: boolean;
  tags?: Record<string, string>;
}

export interface TaskDefinitionConfig {
  family: string;
  cpu: number;
  memory: number;
  containerName: string;
  containerImage: string;
  containerPort: number;
  healthCheckPath: string;
  secretsArn: pulumi.Input<string>;
  logRetentionDays: number;
  environment: string;
  executionRoleArn: pulumi.Input<string>;
  taskRoleArn: pulumi.Input<string>;
  tags?: Record<string, string>;
}

export interface EcsServiceConfig {
  name: string;
  clusterArn: pulumi.Input<string>;
  taskDefinitionArn: pulumi.Input<string>;
  desiredCount: number;
  minHealthyPercent: number;
  maxPercent: number;
  subnets: pulumi.Input<string>[];
  securityGroups: pulumi.Input<string>[];
  targetGroupArn: pulumi.Input<string>;
  containerName: string;
  containerPort: number;
  capacityProviderBase: number;
  capacityProviderWeight: number;
  spotWeight: number;
  enableExecuteCommand: boolean;
  tags?: Record<string, string>;
}

export interface AutoscalingConfig {
  serviceName: string;
  clusterName: string;
  minCapacity: number;
  maxCapacity: number;
  cpuTargetValue: number;
  memoryTargetValue: number;
  scaleInCooldown: number;
  scaleOutCooldown: number;
  tags?: Record<string, string>;
}

export interface MonitoringConfig {
  serviceName: string;
  clusterName: string;
  environment: string;
  cpuThresholdWarning: number;
  cpuThresholdCritical: number;
  memoryThresholdWarning: number;
  memoryThresholdCritical: number;
  alertEmails: string[];
  slackWebhookUrl?: string;
  tags?: Record<string, string>;
}

export interface NetworkConfig {
  vpcId: string;
  publicSubnetIds: string[];
  privateSubnetIds: string[];
  albSecurityGroupId: string;
  ecsSecurityGroupId: string;
}

export interface DisasterRecoveryConfig {
  enableMultiAz: boolean;
  enableBackup: boolean;
  backupRetentionDays: number;
  enableCrossRegionBackup: boolean;
  secondaryRegion?: string;
}
