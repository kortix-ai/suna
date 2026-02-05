import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

import {
  COMMON_TAGS,
  EcsCluster,
  HybridTaskDefinition,
  EcsAutoscaling,
  ScheduledScaling,
  EcsMonitoring,
  ServiceHealthCheck,
  EcsIamRoles,
  DisasterRecovery,
  FailoverAlarms,
} from "../../components";

const config = new pulumi.Config();
const awsConfig = new pulumi.Config("aws");
const environment = "prod";
const region = awsConfig.require("region");

const networkConfig = {
  vpcId: config.require("vpcId"),
  publicSubnets: config.requireObject<string[]>("publicSubnets"),
  privateSubnets: config.requireObject<string[]>("privateSubnets"),
  albSecurityGroup: config.require("albSecurityGroupId"),
  ecsSecurityGroup: config.require("ecsSecurityGroupId"),
  targetGroupArn: config.require("targetGroupArn"),
  loadBalancerArn: config.require("loadBalancerArn"),
};

const serviceConfig = {
  name: config.get("serviceName") || "suna-api",
  containerImage: config.require("containerImage"),
  containerPort: config.getNumber("containerPort") || 8000,
  healthCheckPath: config.get("healthCheckPath") || "/v1/health-docker",
  cpu: config.getNumber("taskCpu") || 512,
  memory: config.getNumber("taskMemory") || 1024,
  desiredCount: config.getNumber("desiredCount") || 2,
  minCapacity: config.getNumber("minCapacity") || 1,
  maxCapacity: config.getNumber("maxCapacity") || 100,
};

const capacityConfig = {
  fargateSpotWeight: config.getNumber("fargateSpotWeight") || 4,
  fargateWeight: config.getNumber("fargateWeight") || 1,
  fargateBase: config.getNumber("fargateBase") || 1,
};

const autoscalingConfig = {
  cpuTargetValue: config.getNumber("cpuTargetValue") || 70,
  memoryTargetValue: config.getNumber("memoryTargetValue") || 75,
  scaleInCooldown: config.getNumber("scaleInCooldown") || 300,
  scaleOutCooldown: config.getNumber("scaleOutCooldown") || 60,
};

const monitoringConfig = {
  cpuWarning: config.getNumber("cpuWarningThreshold") || 70,
  cpuCritical: config.getNumber("cpuCriticalThreshold") || 85,
  memoryWarning: config.getNumber("memoryWarningThreshold") || 75,
  memoryCritical: config.getNumber("memoryCriticalThreshold") || 90,
  latencyThresholdMs: config.getNumber("latencyThresholdMs") || 2000,
  errorRateThreshold: config.getNumber("errorRateThreshold") || 5,
  alertEmails: config.requireObject<string[]>("alertEmails"),
};

const secretsManagerArn = config.requireSecret("secretsManagerArn");
const cloudflareTunnelId = config.requireSecret("cloudflareTunnelId");
const albDnsName = config.require("albDnsName");

const lightsailConfig = {
  bundleId: config.get("lightsailBundleId") || "8xlarge_3_0",
  keyPairName: config.require("lightsailKeyPairName"),
};

const lightsailInstance = new aws.lightsail.Instance("suna-prod-instance", {
  name: "suna-prod",
  availabilityZone: `${region}a`,
  blueprintId: "ubuntu_24_04",
  bundleId: lightsailConfig.bundleId,
  keyPairName: lightsailConfig.keyPairName,
  tags: {
    ...COMMON_TAGS,
    Environment: environment,
    Name: "suna-prod",
  },
});

new aws.lightsail.InstancePublicPorts("suna-prod-ports", {
  instanceName: lightsailInstance.name,
  portInfos: [{
    protocol: "tcp",
    fromPort: 22,
    toPort: 22,
    cidrs: ["0.0.0.0/0"],
  }],
});

const iamRoles = new EcsIamRoles("suna-ecs-iam", {
  serviceName: serviceConfig.name,
  secretsArn: secretsManagerArn,
  tags: COMMON_TAGS,
});

const cluster = new EcsCluster("suna-ecs-cluster", {
  name: "suna-ecs",
  environment: environment,
  containerInsights: true,
  tags: COMMON_TAGS,
});

const clusterCapacityProviders = new aws.ecs.ClusterCapacityProviders("suna-cluster-cp", {
  clusterName: cluster.clusterName,
  capacityProviders: ["FARGATE", "FARGATE_SPOT"],
  defaultCapacityProviderStrategies: [
    {
      capacityProvider: "FARGATE_SPOT",
      weight: capacityConfig.fargateSpotWeight,
      base: 0,
    },
    {
      capacityProvider: "FARGATE",
      weight: capacityConfig.fargateWeight,
      base: capacityConfig.fargateBase,
    },
  ],
});

const taskDefinition = new HybridTaskDefinition("suna-api-task", {
  family: serviceConfig.name,
  cpu: serviceConfig.cpu,
  memory: serviceConfig.memory,
  containerName: serviceConfig.name,
  containerImage: serviceConfig.containerImage,
  containerPort: serviceConfig.containerPort,
  healthCheckPath: serviceConfig.healthCheckPath,
  secretsArn: secretsManagerArn,
  logRetentionDays: 14,
  environment: environment,
  region: region,
  executionRoleArn: iamRoles.executionRoleArn,
  taskRoleArn: iamRoles.taskRoleArn,
  tags: COMMON_TAGS,
});

const service = new aws.ecs.Service("suna-api-service", {
  name: serviceConfig.name,
  cluster: cluster.clusterArn,
  taskDefinition: taskDefinition.taskDefinitionArn,
  desiredCount: serviceConfig.desiredCount,
  capacityProviderStrategies: [
    {
      capacityProvider: "FARGATE_SPOT",
      weight: capacityConfig.fargateSpotWeight,
      base: 0,
    },
    {
      capacityProvider: "FARGATE",
      weight: capacityConfig.fargateWeight,
      base: capacityConfig.fargateBase,
    },
  ],
  networkConfiguration: {
    subnets: networkConfig.privateSubnets,
    securityGroups: [networkConfig.ecsSecurityGroup],
    assignPublicIp: false,
  },
  loadBalancers: [{
    targetGroupArn: networkConfig.targetGroupArn,
    containerName: serviceConfig.name,
    containerPort: serviceConfig.containerPort,
  }],
  deploymentConfiguration: {
    minimumHealthyPercent: 100,
    maximumPercent: 200,
  },
  deploymentCircuitBreaker: {
    enable: true,
    rollback: true,
  },
  enableExecuteCommand: true,
  healthCheckGracePeriodSeconds: 120,
  propagateTags: "SERVICE",
  enableEcsManagedTags: true,
  tags: COMMON_TAGS,
}, { dependsOn: [clusterCapacityProviders], ignoreChanges: ["desiredCount"] });

const autoscaling = new EcsAutoscaling("suna-api-autoscaling", {
  serviceName: serviceConfig.name,
  clusterName: "suna-ecs",
  minCapacity: serviceConfig.minCapacity,
  maxCapacity: serviceConfig.maxCapacity,
  cpuTargetValue: autoscalingConfig.cpuTargetValue,
  memoryTargetValue: autoscalingConfig.memoryTargetValue,
  scaleInCooldown: autoscalingConfig.scaleInCooldown,
  scaleOutCooldown: autoscalingConfig.scaleOutCooldown,
  tags: COMMON_TAGS,
}, { dependsOn: [service] });

const monitoring = new EcsMonitoring("suna-api-monitoring", {
  serviceName: serviceConfig.name,
  clusterName: "suna-ecs",
  environment: environment,
  cpuThresholdWarning: monitoringConfig.cpuWarning,
  cpuThresholdCritical: monitoringConfig.cpuCritical,
  memoryThresholdWarning: monitoringConfig.memoryWarning,
  memoryThresholdCritical: monitoringConfig.memoryCritical,
  alertEmails: monitoringConfig.alertEmails,
  tags: COMMON_TAGS,
});

const healthChecks = new ServiceHealthCheck("suna-api-health", {
  serviceName: serviceConfig.name,
  targetGroupArn: networkConfig.targetGroupArn,
  loadBalancerArn: networkConfig.loadBalancerArn,
  alertTopicArn: monitoring.alertTopic.arn,
  latencyThresholdMs: monitoringConfig.latencyThresholdMs,
  errorRateThreshold: monitoringConfig.errorRateThreshold,
  tags: COMMON_TAGS,
});

const failoverAlarms = new FailoverAlarms("suna-api-failover", {
  serviceName: serviceConfig.name,
  clusterName: "suna-ecs",
  alertTopicArn: monitoring.alertTopic.arn,
  tags: COMMON_TAGS,
});

const disasterRecovery = new DisasterRecovery("suna-dr", {
  serviceName: serviceConfig.name,
  retentionDays: config.getNumber("backupRetentionDays") || 30,
  enableCrossRegion: config.getBoolean("enableCrossRegionBackup") || false,
  secondaryRegion: config.get("secondaryRegion"),
  resourceArns: [secretsManagerArn],
  tags: COMMON_TAGS,
});

export const outputs = {
  environment,

  lightsail: {
    instanceName: lightsailInstance.name,
    publicIp: lightsailInstance.publicIpAddress,
    privateIp: lightsailInstance.privateIpAddress,
  },

  ecs: {
    clusterName: cluster.clusterName,
    clusterArn: cluster.clusterArn,
    serviceName: service.name,
    taskDefinitionArn: taskDefinition.taskDefinitionArn,
  },

  autoscaling: {
    minTasks: serviceConfig.minCapacity,
    maxTasks: serviceConfig.maxCapacity,
    cpuTarget: autoscalingConfig.cpuTargetValue,
    memoryTarget: autoscalingConfig.memoryTargetValue,
  },

  capacityStrategy: {
    fargateSpotWeight: capacityConfig.fargateSpotWeight,
    fargateWeight: capacityConfig.fargateWeight,
    fargateBase: capacityConfig.fargateBase,
    description: "Fargate Spot primary (80%) + Fargate On-Demand fallback (20%)",
  },

  monitoring: {
    alertTopicArn: monitoring.alertTopic.arn,
    dashboardUrl: pulumi.interpolate`https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#dashboards:name=${serviceConfig.name}-${environment}`,
  },

  cloudflare: {
    tunnelCname: cloudflareTunnelId.apply(id => `${id}.cfargotunnel.com`),
  },

  endpoints: {
    primary: config.get("primaryDomain") || "api.kortix.com",
    lightsail: config.get("lightsailDomain") || "api-lightsail.kortix.com",
    ecs: config.get("ecsDomain") || "api-ecs.kortix.com",
    alb: albDnsName,
  },

  costEstimate: {
    perTask: "$0.015/hr (Spot) or $0.05/hr (On-Demand)",
    minimum: "~$11/mo (1 task always running)",
    at100Users: "~$20-40/mo",
    at1000Users: "~$100-200/mo",
    at10000Users: "~$1500-3000/mo (consider EC2 at this point)",
  },
};

export const setupInstructions = pulumi.interpolate`
=== PRODUCTION ENVIRONMENT (Cost-Optimized) ===

Capacity Strategy:
  • Fargate Spot: 80% of tasks (70% cheaper)
  • Fargate On-Demand: 20% fallback (always available)
  • Base: ${capacityConfig.fargateBase} task(s) always running

Task Configuration:
  • Size: ${serviceConfig.cpu} CPU / ${serviceConfig.memory}MB
  • Range: ${serviceConfig.minCapacity} - ${serviceConfig.maxCapacity} tasks
  • Scaling: CPU > ${autoscalingConfig.cpuTargetValue}% or Memory > ${autoscalingConfig.memoryTargetValue}%

Cost Scaling:
  • 0 users: ~$11/mo (1 base task)
  • 100 users: ~$30/mo (2-3 tasks)
  • 1k users: ~$150/mo (10-15 tasks)
  • 10k users: ~$2000/mo (consider EC2 migration)

When to migrate to EC2:
  • Monthly Fargate bill > $2000
  • Consistent 50%+ utilization
  • Predictable traffic patterns

Endpoints:
  • Primary: https://${outputs.endpoints.primary}
  • ECS: https://${outputs.endpoints.ecs}
`;
