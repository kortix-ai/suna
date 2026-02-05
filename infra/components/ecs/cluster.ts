import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { EcsClusterConfig } from "../types";

export class EcsCluster extends pulumi.ComponentResource {
  public readonly cluster: aws.ecs.Cluster;
  public readonly clusterArn: pulumi.Output<string>;
  public readonly clusterName: pulumi.Output<string>;

  constructor(name: string, config: EcsClusterConfig, opts?: pulumi.ComponentResourceOptions) {
    super("suna:ecs:Cluster", name, {}, opts);

    this.cluster = new aws.ecs.Cluster(name, {
      name: config.name,
      settings: [{
        name: "containerInsights",
        value: config.containerInsights ? "enabled" : "disabled",
      }],
      configuration: {
        executeCommandConfiguration: {
          logging: "OVERRIDE",
          logConfiguration: {
            cloudWatchLogGroupName: `/ecs/${config.name}`,
            cloudWatchEncryptionEnabled: false,
          },
        },
      },
      tags: {
        ...config.tags,
        Environment: config.environment,
        Name: config.name,
      },
    }, { parent: this });

    this.clusterArn = this.cluster.arn;
    this.clusterName = this.cluster.name;

    this.registerOutputs({
      clusterArn: this.clusterArn,
      clusterName: this.clusterName,
    });
  }
}

export interface HybridCapacityConfig {
  clusterName: pulumi.Input<string>;
  ec2CapacityProviderName: pulumi.Input<string>;
  ec2Weight: number;
  ec2Base: number;
  fargateWeight: number;
  fargateSpotWeight: number;
}

export class HybridClusterCapacity extends pulumi.ComponentResource {
  public readonly capacityProviders: aws.ecs.ClusterCapacityProviders;

  constructor(name: string, config: HybridCapacityConfig, opts?: pulumi.ComponentResourceOptions) {
    super("suna:ecs:HybridClusterCapacity", name, {}, opts);

    this.capacityProviders = new aws.ecs.ClusterCapacityProviders(name, {
      clusterName: config.clusterName,
      capacityProviders: [
        config.ec2CapacityProviderName,
        "FARGATE",
        "FARGATE_SPOT",
      ],
      defaultCapacityProviderStrategies: [
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
    }, { parent: this });

    this.registerOutputs({
      capacityProvidersId: this.capacityProviders.id,
    });
  }
}
