import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { AutoscalingConfig } from "../types";

export class EcsAutoscaling extends pulumi.ComponentResource {
  public readonly scalingTarget: aws.appautoscaling.Target;
  public readonly cpuScalingPolicy: aws.appautoscaling.Policy;
  public readonly memoryScalingPolicy: aws.appautoscaling.Policy;
  public readonly requestCountScalingPolicy: aws.appautoscaling.Policy;

  constructor(name: string, config: AutoscalingConfig, opts?: pulumi.ComponentResourceOptions) {
    super("suna:autoscaling:EcsAutoscaling", name, {}, opts);

    const resourceId = pulumi.interpolate`service/${config.clusterName}/${config.serviceName}`;

    this.scalingTarget = new aws.appautoscaling.Target(`${name}-target`, {
      maxCapacity: config.maxCapacity,
      minCapacity: config.minCapacity,
      resourceId: resourceId,
      scalableDimension: "ecs:service:DesiredCount",
      serviceNamespace: "ecs",
      tags: config.tags,
    }, { parent: this });

    this.cpuScalingPolicy = new aws.appautoscaling.Policy(`${name}-cpu-policy`, {
      name: `${config.serviceName}-cpu-scaling`,
      policyType: "TargetTrackingScaling",
      resourceId: this.scalingTarget.resourceId,
      scalableDimension: this.scalingTarget.scalableDimension,
      serviceNamespace: this.scalingTarget.serviceNamespace,
      targetTrackingScalingPolicyConfiguration: {
        predefinedMetricSpecification: {
          predefinedMetricType: "ECSServiceAverageCPUUtilization",
        },
        targetValue: config.cpuTargetValue,
        scaleInCooldown: config.scaleInCooldown,
        scaleOutCooldown: config.scaleOutCooldown,
      },
    }, { parent: this });

    this.memoryScalingPolicy = new aws.appautoscaling.Policy(`${name}-memory-policy`, {
      name: `${config.serviceName}-memory-scaling`,
      policyType: "TargetTrackingScaling",
      resourceId: this.scalingTarget.resourceId,
      scalableDimension: this.scalingTarget.scalableDimension,
      serviceNamespace: this.scalingTarget.serviceNamespace,
      targetTrackingScalingPolicyConfiguration: {
        predefinedMetricSpecification: {
          predefinedMetricType: "ECSServiceAverageMemoryUtilization",
        },
        targetValue: config.memoryTargetValue,
        scaleInCooldown: config.scaleInCooldown,
        scaleOutCooldown: config.scaleOutCooldown,
      },
    }, { parent: this });

    this.requestCountScalingPolicy = new aws.appautoscaling.Policy(`${name}-request-policy`, {
      name: `${config.serviceName}-request-scaling`,
      policyType: "TargetTrackingScaling",
      resourceId: this.scalingTarget.resourceId,
      scalableDimension: this.scalingTarget.scalableDimension,
      serviceNamespace: this.scalingTarget.serviceNamespace,
      targetTrackingScalingPolicyConfiguration: {
        predefinedMetricSpecification: {
          predefinedMetricType: "ALBRequestCountPerTarget",
          resourceLabel: pulumi.interpolate`app/${config.clusterName}/${config.serviceName}`,
        },
        targetValue: 1000,
        scaleInCooldown: config.scaleInCooldown,
        scaleOutCooldown: config.scaleOutCooldown,
      },
    }, { parent: this });

    this.registerOutputs({
      scalingTargetArn: this.scalingTarget.id,
      cpuPolicyArn: this.cpuScalingPolicy.arn,
      memoryPolicyArn: this.memoryScalingPolicy.arn,
    });
  }
}

export class ScheduledScaling extends pulumi.ComponentResource {
  public readonly scaleUpAction: aws.appautoscaling.ScheduledAction;
  public readonly scaleDownAction: aws.appautoscaling.ScheduledAction;

  constructor(
    name: string,
    config: {
      serviceName: string;
      clusterName: string;
      peakHoursMinCapacity: number;
      peakHoursMaxCapacity: number;
      offPeakMinCapacity: number;
      offPeakMaxCapacity: number;
      peakStartCron: string;
      peakEndCron: string;
      timezone: string;
    },
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("suna:autoscaling:ScheduledScaling", name, {}, opts);

    const resourceId = pulumi.interpolate`service/${config.clusterName}/${config.serviceName}`;

    this.scaleUpAction = new aws.appautoscaling.ScheduledAction(`${name}-scale-up`, {
      name: `${config.serviceName}-peak-hours`,
      serviceNamespace: "ecs",
      resourceId: resourceId,
      scalableDimension: "ecs:service:DesiredCount",
      schedule: config.peakStartCron,
      timezone: config.timezone,
      scalableTargetAction: {
        minCapacity: config.peakHoursMinCapacity,
        maxCapacity: config.peakHoursMaxCapacity,
      },
    }, { parent: this });

    this.scaleDownAction = new aws.appautoscaling.ScheduledAction(`${name}-scale-down`, {
      name: `${config.serviceName}-off-peak`,
      serviceNamespace: "ecs",
      resourceId: resourceId,
      scalableDimension: "ecs:service:DesiredCount",
      schedule: config.peakEndCron,
      timezone: config.timezone,
      scalableTargetAction: {
        minCapacity: config.offPeakMinCapacity,
        maxCapacity: config.offPeakMaxCapacity,
      },
    }, { parent: this });

    this.registerOutputs({
      scaleUpActionArn: this.scaleUpAction.arn,
      scaleDownActionArn: this.scaleDownAction.arn,
    });
  }
}
