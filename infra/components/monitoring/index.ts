import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { MonitoringConfig } from "../types";

export class EcsMonitoring extends pulumi.ComponentResource {
  public readonly alertTopic: aws.sns.Topic;
  public readonly cpuWarningAlarm: aws.cloudwatch.MetricAlarm;
  public readonly cpuCriticalAlarm: aws.cloudwatch.MetricAlarm;
  public readonly memoryWarningAlarm: aws.cloudwatch.MetricAlarm;
  public readonly memoryCriticalAlarm: aws.cloudwatch.MetricAlarm;
  public readonly runningTasksAlarm: aws.cloudwatch.MetricAlarm;
  public readonly unhealthyHostsAlarm: aws.cloudwatch.MetricAlarm;
  public readonly dashboard: aws.cloudwatch.Dashboard;

  constructor(name: string, config: MonitoringConfig, opts?: pulumi.ComponentResourceOptions) {
    super("suna:monitoring:EcsMonitoring", name, {}, opts);

    this.alertTopic = new aws.sns.Topic(`${name}-alerts`, {
      name: `${config.serviceName}-alerts`,
      tags: {
        ...config.tags,
        Environment: config.environment,
      },
    }, { parent: this });

    config.alertEmails.forEach((email, index) => {
      new aws.sns.TopicSubscription(`${name}-email-${index}`, {
        topic: this.alertTopic.arn,
        protocol: "email",
        endpoint: email,
      }, { parent: this });
    });

    this.cpuWarningAlarm = new aws.cloudwatch.MetricAlarm(`${name}-cpu-warning`, {
      name: `${config.serviceName}-cpu-warning`,
      comparisonOperator: "GreaterThanThreshold",
      evaluationPeriods: 2,
      metricName: "CPUUtilization",
      namespace: "AWS/ECS",
      period: 300,
      statistic: "Average",
      threshold: config.cpuThresholdWarning,
      alarmDescription: `CPU utilization exceeded ${config.cpuThresholdWarning}%`,
      dimensions: {
        ClusterName: config.clusterName,
        ServiceName: config.serviceName,
      },
      alarmActions: [this.alertTopic.arn],
      okActions: [this.alertTopic.arn],
      treatMissingData: "notBreaching",
      tags: config.tags,
    }, { parent: this });

    this.cpuCriticalAlarm = new aws.cloudwatch.MetricAlarm(`${name}-cpu-critical`, {
      name: `${config.serviceName}-cpu-critical`,
      comparisonOperator: "GreaterThanThreshold",
      evaluationPeriods: 2,
      metricName: "CPUUtilization",
      namespace: "AWS/ECS",
      period: 60,
      statistic: "Average",
      threshold: config.cpuThresholdCritical,
      alarmDescription: `CRITICAL: CPU utilization exceeded ${config.cpuThresholdCritical}%`,
      dimensions: {
        ClusterName: config.clusterName,
        ServiceName: config.serviceName,
      },
      alarmActions: [this.alertTopic.arn],
      okActions: [this.alertTopic.arn],
      treatMissingData: "notBreaching",
      tags: config.tags,
    }, { parent: this });

    this.memoryWarningAlarm = new aws.cloudwatch.MetricAlarm(`${name}-memory-warning`, {
      name: `${config.serviceName}-memory-warning`,
      comparisonOperator: "GreaterThanThreshold",
      evaluationPeriods: 2,
      metricName: "MemoryUtilization",
      namespace: "AWS/ECS",
      period: 300,
      statistic: "Average",
      threshold: config.memoryThresholdWarning,
      alarmDescription: `Memory utilization exceeded ${config.memoryThresholdWarning}%`,
      dimensions: {
        ClusterName: config.clusterName,
        ServiceName: config.serviceName,
      },
      alarmActions: [this.alertTopic.arn],
      okActions: [this.alertTopic.arn],
      treatMissingData: "notBreaching",
      tags: config.tags,
    }, { parent: this });

    this.memoryCriticalAlarm = new aws.cloudwatch.MetricAlarm(`${name}-memory-critical`, {
      name: `${config.serviceName}-memory-critical`,
      comparisonOperator: "GreaterThanThreshold",
      evaluationPeriods: 2,
      metricName: "MemoryUtilization",
      namespace: "AWS/ECS",
      period: 60,
      statistic: "Average",
      threshold: config.memoryThresholdCritical,
      alarmDescription: `CRITICAL: Memory utilization exceeded ${config.memoryThresholdCritical}%`,
      dimensions: {
        ClusterName: config.clusterName,
        ServiceName: config.serviceName,
      },
      alarmActions: [this.alertTopic.arn],
      okActions: [this.alertTopic.arn],
      treatMissingData: "notBreaching",
      tags: config.tags,
    }, { parent: this });

    this.runningTasksAlarm = new aws.cloudwatch.MetricAlarm(`${name}-running-tasks`, {
      name: `${config.serviceName}-running-tasks-low`,
      comparisonOperator: "LessThanThreshold",
      evaluationPeriods: 2,
      metricName: "RunningTaskCount",
      namespace: "ECS/ContainerInsights",
      period: 60,
      statistic: "Average",
      threshold: 1,
      alarmDescription: "CRITICAL: No running tasks detected",
      dimensions: {
        ClusterName: config.clusterName,
        ServiceName: config.serviceName,
      },
      alarmActions: [this.alertTopic.arn],
      okActions: [this.alertTopic.arn],
      treatMissingData: "breaching",
      tags: config.tags,
    }, { parent: this });

    this.unhealthyHostsAlarm = new aws.cloudwatch.MetricAlarm(`${name}-unhealthy-hosts`, {
      name: `${config.serviceName}-unhealthy-hosts`,
      comparisonOperator: "GreaterThanThreshold",
      evaluationPeriods: 2,
      metricName: "UnHealthyHostCount",
      namespace: "AWS/ApplicationELB",
      period: 60,
      statistic: "Average",
      threshold: 0,
      alarmDescription: "Unhealthy hosts detected in target group",
      dimensions: {
        TargetGroup: `targetgroup/${config.serviceName}`,
        LoadBalancer: `app/${config.clusterName}`,
      },
      alarmActions: [this.alertTopic.arn],
      okActions: [this.alertTopic.arn],
      treatMissingData: "notBreaching",
      tags: config.tags,
    }, { parent: this });

    const dashboardBody = pulumi.all([config.clusterName, config.serviceName]).apply(
      ([clusterName, serviceName]) => JSON.stringify({
        widgets: [
          {
            type: "metric",
            x: 0,
            y: 0,
            width: 12,
            height: 6,
            properties: {
              title: "CPU Utilization",
              region: "us-west-2",
              metrics: [
                ["AWS/ECS", "CPUUtilization", "ClusterName", clusterName, "ServiceName", serviceName],
              ],
              period: 60,
              stat: "Average",
              annotations: {
                horizontal: [
                  { value: config.cpuThresholdWarning, label: "Warning" },
                  { value: config.cpuThresholdCritical, label: "Critical" },
                ],
              },
            },
          },
          {
            type: "metric",
            x: 12,
            y: 0,
            width: 12,
            height: 6,
            properties: {
              title: "Memory Utilization",
              region: "us-west-2",
              metrics: [
                ["AWS/ECS", "MemoryUtilization", "ClusterName", clusterName, "ServiceName", serviceName],
              ],
              period: 60,
              stat: "Average",
              annotations: {
                horizontal: [
                  { value: config.memoryThresholdWarning, label: "Warning" },
                  { value: config.memoryThresholdCritical, label: "Critical" },
                ],
              },
            },
          },
          {
            type: "metric",
            x: 0,
            y: 6,
            width: 12,
            height: 6,
            properties: {
              title: "Running Tasks",
              region: "us-west-2",
              metrics: [
                ["ECS/ContainerInsights", "RunningTaskCount", "ClusterName", clusterName, "ServiceName", serviceName],
                ["ECS/ContainerInsights", "DesiredTaskCount", "ClusterName", clusterName, "ServiceName", serviceName],
              ],
              period: 60,
              stat: "Average",
            },
          },
          {
            type: "metric",
            x: 12,
            y: 6,
            width: 12,
            height: 6,
            properties: {
              title: "Network IO",
              region: "us-west-2",
              metrics: [
                ["ECS/ContainerInsights", "NetworkRxBytes", "ClusterName", clusterName, "ServiceName", serviceName],
                ["ECS/ContainerInsights", "NetworkTxBytes", "ClusterName", clusterName, "ServiceName", serviceName],
              ],
              period: 60,
              stat: "Average",
            },
          },
          {
            type: "metric",
            x: 0,
            y: 12,
            width: 24,
            height: 6,
            properties: {
              title: "Task Health",
              region: "us-west-2",
              metrics: [
                ["ECS/ContainerInsights", "PendingTaskCount", "ClusterName", clusterName, "ServiceName", serviceName],
                ["ECS/ContainerInsights", "TaskSetCount", "ClusterName", clusterName, "ServiceName", serviceName],
              ],
              period: 60,
              stat: "Average",
            },
          },
        ],
      })
    );

    this.dashboard = new aws.cloudwatch.Dashboard(`${name}-dashboard`, {
      dashboardName: `${config.serviceName}-${config.environment}`,
      dashboardBody: dashboardBody,
    }, { parent: this });

    this.registerOutputs({
      alertTopicArn: this.alertTopic.arn,
      dashboardArn: this.dashboard.dashboardArn,
    });
  }
}

export class ServiceHealthCheck extends pulumi.ComponentResource {
  public readonly healthCheckAlarm: aws.cloudwatch.MetricAlarm;
  public readonly latencyAlarm: aws.cloudwatch.MetricAlarm;
  public readonly errorRateAlarm: aws.cloudwatch.MetricAlarm;

  constructor(
    name: string,
    config: {
      serviceName: string;
      targetGroupArn: pulumi.Input<string>;
      loadBalancerArn: pulumi.Input<string>;
      alertTopicArn: pulumi.Input<string>;
      latencyThresholdMs: number;
      errorRateThreshold: number;
      tags?: Record<string, string>;
    },
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("suna:monitoring:ServiceHealthCheck", name, {}, opts);

    this.latencyAlarm = new aws.cloudwatch.MetricAlarm(`${name}-latency`, {
      name: `${config.serviceName}-high-latency`,
      comparisonOperator: "GreaterThanThreshold",
      evaluationPeriods: 3,
      metricName: "TargetResponseTime",
      namespace: "AWS/ApplicationELB",
      period: 60,
      extendedStatistic: "p99",
      threshold: config.latencyThresholdMs / 1000,
      alarmDescription: `P99 latency exceeded ${config.latencyThresholdMs}ms`,
      dimensions: {
        LoadBalancer: config.loadBalancerArn,
        TargetGroup: config.targetGroupArn,
      },
      alarmActions: [config.alertTopicArn],
      okActions: [config.alertTopicArn],
      treatMissingData: "notBreaching",
      tags: config.tags,
    }, { parent: this });

    this.errorRateAlarm = new aws.cloudwatch.MetricAlarm(`${name}-error-rate`, {
      name: `${config.serviceName}-high-error-rate`,
      comparisonOperator: "GreaterThanThreshold",
      evaluationPeriods: 2,
      threshold: config.errorRateThreshold,
      alarmDescription: `Error rate exceeded ${config.errorRateThreshold}%`,
      alarmActions: [config.alertTopicArn],
      okActions: [config.alertTopicArn],
      treatMissingData: "notBreaching",
      metricQueries: [
        {
          id: "error_rate",
          expression: "(m1/m2)*100",
          label: "Error Rate",
          returnData: true,
        },
        {
          id: "m1",
          metric: {
            metricName: "HTTPCode_Target_5XX_Count",
            namespace: "AWS/ApplicationELB",
            period: 60,
            stat: "Sum",
            dimensions: {
              LoadBalancer: config.loadBalancerArn,
              TargetGroup: config.targetGroupArn,
            },
          },
        },
        {
          id: "m2",
          metric: {
            metricName: "RequestCount",
            namespace: "AWS/ApplicationELB",
            period: 60,
            stat: "Sum",
            dimensions: {
              LoadBalancer: config.loadBalancerArn,
              TargetGroup: config.targetGroupArn,
            },
          },
        },
      ],
      tags: config.tags,
    }, { parent: this });

    this.healthCheckAlarm = new aws.cloudwatch.MetricAlarm(`${name}-health`, {
      name: `${config.serviceName}-health-check-failed`,
      comparisonOperator: "LessThanThreshold",
      evaluationPeriods: 2,
      metricName: "HealthyHostCount",
      namespace: "AWS/ApplicationELB",
      period: 60,
      statistic: "Minimum",
      threshold: 1,
      alarmDescription: "No healthy hosts in target group",
      dimensions: {
        LoadBalancer: config.loadBalancerArn,
        TargetGroup: config.targetGroupArn,
      },
      alarmActions: [config.alertTopicArn],
      okActions: [config.alertTopicArn],
      treatMissingData: "breaching",
      tags: config.tags,
    }, { parent: this });

    this.registerOutputs({
      latencyAlarmArn: this.latencyAlarm.arn,
      errorRateAlarmArn: this.errorRateAlarm.arn,
      healthCheckAlarmArn: this.healthCheckAlarm.arn,
    });
  }
}
