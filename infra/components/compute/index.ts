import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export interface Ec2CapacityConfig {
  name: string;
  vpcId: pulumi.Input<string>;
  subnetIds: pulumi.Input<string>[];
  securityGroupIds: pulumi.Input<string>[];
  instanceTypes: string[];
  spotInstanceTypes: string[];
  minSize: number;
  maxSize: number;
  desiredCapacity: number;
  spotAllocationStrategy: "lowest-price" | "capacity-optimized" | "capacity-optimized-prioritized";
  onDemandBaseCapacity: number;
  onDemandPercentageAboveBase: number;
  spotMaxPrice?: string;
  keyName?: string;
  enableDetailedMonitoring: boolean;
  tags?: Record<string, string>;
}

export class Ec2Capacity extends pulumi.ComponentResource {
  public readonly launchTemplate: aws.ec2.LaunchTemplate;
  public readonly autoScalingGroup: aws.autoscaling.Group;
  public readonly capacityProvider: aws.ecs.CapacityProvider;

  constructor(name: string, config: Ec2CapacityConfig, clusterArn: pulumi.Input<string>, opts?: pulumi.ComponentResourceOptions) {
    super("suna:compute:Ec2Capacity", name, {}, opts);

    const ecsOptimizedAmi = aws.ssm.getParameterOutput({
      name: "/aws/service/ecs/optimized-ami/amazon-linux-2023/arm64/recommended/image_id",
    });

    const instanceRole = new aws.iam.Role(`${name}-instance-role`, {
      name: `${config.name}-ecs-instance-role`,
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Action: "sts:AssumeRole",
          Effect: "Allow",
          Principal: {
            Service: "ec2.amazonaws.com",
          },
        }],
      }),
      tags: config.tags,
    }, { parent: this });

    new aws.iam.RolePolicyAttachment(`${name}-ecs-policy`, {
      role: instanceRole.name,
      policyArn: "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role",
    }, { parent: this });

    new aws.iam.RolePolicyAttachment(`${name}-ssm-policy`, {
      role: instanceRole.name,
      policyArn: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
    }, { parent: this });

    const instanceProfile = new aws.iam.InstanceProfile(`${name}-instance-profile`, {
      name: `${config.name}-ecs-instance-profile`,
      role: instanceRole.name,
    }, { parent: this });

    const userData = pulumi.interpolate`#!/bin/bash
echo "ECS_CLUSTER=${clusterArn}" >> /etc/ecs/ecs.config
echo "ECS_ENABLE_SPOT_INSTANCE_DRAINING=true" >> /etc/ecs/ecs.config
echo "ECS_CONTAINER_STOP_TIMEOUT=90s" >> /etc/ecs/ecs.config
echo "ECS_ENGINE_TASK_CLEANUP_WAIT_DURATION=15m" >> /etc/ecs/ecs.config
`;

    this.launchTemplate = new aws.ec2.LaunchTemplate(`${name}-lt`, {
      name: `${config.name}-ecs-lt`,
      imageId: ecsOptimizedAmi.value,
      instanceType: config.instanceTypes[0],
      keyName: config.keyName,
      iamInstanceProfile: {
        arn: instanceProfile.arn,
      },
      monitoring: {
        enabled: config.enableDetailedMonitoring,
      },
      networkInterfaces: [{
        associatePublicIpAddress: "false",
        securityGroups: config.securityGroupIds,
      }],
      userData: userData.apply(ud => Buffer.from(ud).toString("base64")),
      blockDeviceMappings: [{
        deviceName: "/dev/xvda",
        ebs: {
          volumeSize: 50,
          volumeType: "gp3",
          encrypted: "true",
          deleteOnTermination: "true",
        },
      }],
      tagSpecifications: [
        {
          resourceType: "instance",
          tags: {
            ...config.tags,
            Name: `${config.name}-ecs-instance`,
          },
        },
        {
          resourceType: "volume",
          tags: config.tags,
        },
      ],
      tags: config.tags,
    }, { parent: this });

    this.autoScalingGroup = new aws.autoscaling.Group(`${name}-asg`, {
      name: `${config.name}-ecs-asg`,
      minSize: config.minSize,
      maxSize: config.maxSize,
      desiredCapacity: config.desiredCapacity,
      vpcZoneIdentifiers: config.subnetIds,
      healthCheckType: "EC2",
      healthCheckGracePeriod: 300,
      protectFromScaleIn: true,
      mixedInstancesPolicy: {
        instancesDistribution: {
          onDemandBaseCapacity: config.onDemandBaseCapacity,
          onDemandPercentageAboveBaseCapacity: config.onDemandPercentageAboveBase,
          spotAllocationStrategy: config.spotAllocationStrategy,
          spotMaxPrice: config.spotMaxPrice,
        },
        launchTemplate: {
          launchTemplateSpecification: {
            launchTemplateId: this.launchTemplate.id,
            version: "$Latest",
          },
          overrides: [
            ...config.instanceTypes.map(type => ({ instanceType: type })),
            ...config.spotInstanceTypes.map(type => ({ instanceType: type })),
          ],
        },
      },
      tags: Object.entries(config.tags || {}).map(([key, value]) => ({
        key,
        value,
        propagateAtLaunch: true,
      })),
    }, { parent: this });

    this.capacityProvider = new aws.ecs.CapacityProvider(`${name}-cp`, {
      name: `${config.name}-ec2-cp`,
      autoScalingGroupProvider: {
        autoScalingGroupArn: this.autoScalingGroup.arn,
        managedScaling: {
          status: "ENABLED",
          targetCapacity: 100,
          minimumScalingStepSize: 1,
          maximumScalingStepSize: 2,
          instanceWarmupPeriod: 120,
        },
        managedTerminationProtection: "ENABLED",
        managedDraining: "ENABLED",
      },
      tags: config.tags,
    }, { parent: this });

    this.registerOutputs({
      launchTemplateId: this.launchTemplate.id,
      autoScalingGroupArn: this.autoScalingGroup.arn,
      capacityProviderArn: this.capacityProvider.arn,
    });
  }
}
