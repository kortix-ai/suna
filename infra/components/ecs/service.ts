import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { EcsServiceConfig } from "../types";

export interface Ec2ServiceConfig {
  name: string;
  clusterArn: pulumi.Input<string>;
  taskDefinitionArn: pulumi.Input<string>;
  capacityProviderName: pulumi.Input<string>;
  desiredCount: number;
  minHealthyPercent: number;
  maxPercent: number;
  targetGroupArn: pulumi.Input<string>;
  containerName: string;
  containerPort: number;
  enableExecuteCommand: boolean;
  placementStrategies?: { type: string; field?: string }[];
  tags?: Record<string, string>;
}

export class EcsService extends pulumi.ComponentResource {
  public readonly service: aws.ecs.Service;
  public readonly serviceArn: pulumi.Output<string>;
  public readonly serviceName: pulumi.Output<string>;

  constructor(name: string, config: EcsServiceConfig, opts?: pulumi.ComponentResourceOptions) {
    super("suna:ecs:Service", name, {}, opts);

    this.service = new aws.ecs.Service(name, {
      name: config.name,
      cluster: config.clusterArn,
      taskDefinition: config.taskDefinitionArn,
      desiredCount: config.desiredCount,
      launchType: undefined,
      capacityProviderStrategies: [
        {
          capacityProvider: "FARGATE",
          base: config.capacityProviderBase,
          weight: config.capacityProviderWeight,
        },
        {
          capacityProvider: "FARGATE_SPOT",
          base: 0,
          weight: config.spotWeight,
        },
      ],
      networkConfiguration: {
        subnets: config.subnets,
        securityGroups: config.securityGroups,
        assignPublicIp: false,
      },
      loadBalancers: [{
        targetGroupArn: config.targetGroupArn,
        containerName: config.containerName,
        containerPort: config.containerPort,
      }],
      deploymentConfiguration: {
        minimumHealthyPercent: config.minHealthyPercent,
        maximumPercent: config.maxPercent,
      },
      deploymentCircuitBreaker: {
        enable: true,
        rollback: true,
      },
      enableExecuteCommand: config.enableExecuteCommand,
      healthCheckGracePeriodSeconds: 120,
      propagateTags: "SERVICE",
      enableEcsManagedTags: true,
      tags: config.tags,
    }, {
      parent: this,
      ignoreChanges: ["desiredCount"],
    });

    this.serviceArn = this.service.id;
    this.serviceName = this.service.name;

    this.registerOutputs({
      serviceArn: this.serviceArn,
      serviceName: this.serviceName,
    });
  }
}

export class Ec2EcsService extends pulumi.ComponentResource {
  public readonly service: aws.ecs.Service;
  public readonly serviceArn: pulumi.Output<string>;
  public readonly serviceName: pulumi.Output<string>;

  constructor(name: string, config: Ec2ServiceConfig, opts?: pulumi.ComponentResourceOptions) {
    super("suna:ecs:Ec2EcsService", name, {}, opts);

    this.service = new aws.ecs.Service(name, {
      name: config.name,
      cluster: config.clusterArn,
      taskDefinition: config.taskDefinitionArn,
      desiredCount: config.desiredCount,
      capacityProviderStrategies: [{
        capacityProvider: config.capacityProviderName,
        base: config.desiredCount,
        weight: 1,
      }],
      loadBalancers: [{
        targetGroupArn: config.targetGroupArn,
        containerName: config.containerName,
        containerPort: config.containerPort,
      }],
      deploymentConfiguration: {
        minimumHealthyPercent: config.minHealthyPercent,
        maximumPercent: config.maxPercent,
      },
      deploymentCircuitBreaker: {
        enable: true,
        rollback: true,
      },
      enableExecuteCommand: config.enableExecuteCommand,
      healthCheckGracePeriodSeconds: 120,
      orderedPlacementStrategies: config.placementStrategies || [
        { type: "spread", field: "attribute:ecs.availability-zone" },
        { type: "binpack", field: "memory" },
      ],
      propagateTags: "SERVICE",
      enableEcsManagedTags: true,
      tags: config.tags,
    }, {
      parent: this,
      ignoreChanges: ["desiredCount"],
    });

    this.serviceArn = this.service.id;
    this.serviceName = this.service.name;

    this.registerOutputs({
      serviceArn: this.serviceArn,
      serviceName: this.serviceName,
    });
  }
}

export interface HybridServiceConfig {
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
  enableExecuteCommand: boolean;
  ec2CapacityProviderName: pulumi.Input<string>;
  ec2Weight: number;
  ec2Base: number;
  fargateSpotWeight: number;
  fargateWeight: number;
  tags?: Record<string, string>;
}

export class HybridEcsService extends pulumi.ComponentResource {
  public readonly service: aws.ecs.Service;
  public readonly serviceArn: pulumi.Output<string>;
  public readonly serviceName: pulumi.Output<string>;

  constructor(name: string, config: HybridServiceConfig, opts?: pulumi.ComponentResourceOptions) {
    super("suna:ecs:HybridEcsService", name, {}, opts);

    this.service = new aws.ecs.Service(name, {
      name: config.name,
      cluster: config.clusterArn,
      taskDefinition: config.taskDefinitionArn,
      desiredCount: config.desiredCount,
      capacityProviderStrategies: [
        {
          capacityProvider: config.ec2CapacityProviderName,
          weight: config.ec2Weight,
          base: config.ec2Base,
        },
        {
          capacityProvider: "FARGATE_SPOT",
          weight: config.fargateSpotWeight,
          base: 0,
        },
        {
          capacityProvider: "FARGATE",
          weight: config.fargateWeight,
          base: 0,
        },
      ],
      networkConfiguration: {
        subnets: config.subnets,
        securityGroups: config.securityGroups,
        assignPublicIp: false,
      },
      loadBalancers: [{
        targetGroupArn: config.targetGroupArn,
        containerName: config.containerName,
        containerPort: config.containerPort,
      }],
      deploymentConfiguration: {
        minimumHealthyPercent: config.minHealthyPercent,
        maximumPercent: config.maxPercent,
      },
      deploymentCircuitBreaker: {
        enable: true,
        rollback: true,
      },
      enableExecuteCommand: config.enableExecuteCommand,
      healthCheckGracePeriodSeconds: 120,
      propagateTags: "SERVICE",
      enableEcsManagedTags: true,
      tags: config.tags,
    }, {
      parent: this,
      ignoreChanges: ["desiredCount"],
    });

    this.serviceArn = this.service.id;
    this.serviceName = this.service.name;

    this.registerOutputs({
      serviceArn: this.serviceArn,
      serviceName: this.serviceName,
    });
  }
}
