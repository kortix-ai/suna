import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { MonitoringConfig } from "./types";

export class EksMonitoring extends pulumi.ComponentResource {
  public readonly alertTopic: aws.sns.Topic;
  public readonly cpuWarningAlarm: aws.cloudwatch.MetricAlarm;
  public readonly cpuCriticalAlarm: aws.cloudwatch.MetricAlarm;
  public readonly memoryWarningAlarm: aws.cloudwatch.MetricAlarm;
  public readonly memoryCriticalAlarm: aws.cloudwatch.MetricAlarm;
  public readonly podCountAlarm: aws.cloudwatch.MetricAlarm;
  public readonly nodeCountAlarm: aws.cloudwatch.MetricAlarm;
  public readonly dashboard: aws.cloudwatch.Dashboard;

  constructor(name: string, config: MonitoringConfig, opts?: pulumi.ComponentResourceOptions) {
    super("suna:monitoring:EksMonitoring", name, {}, opts);

    this.alertTopic = new aws.sns.Topic(`${name}-alerts`, {
      name: `${config.deploymentName}-alerts`,
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
      name: `${config.deploymentName}-cpu-warning`,
      comparisonOperator: "GreaterThanThreshold",
      evaluationPeriods: 2,
      metricName: "node_cpu_utilization",
      namespace: "ContainerInsights",
      period: 300,
      statistic: "Average",
      threshold: config.cpuThresholdWarning,
      alarmDescription: `CPU utilization exceeded ${config.cpuThresholdWarning}%`,
      dimensions: {
        ClusterName: config.clusterName,
      },
      alarmActions: [this.alertTopic.arn],
      okActions: [this.alertTopic.arn],
      treatMissingData: "notBreaching",
      tags: config.tags,
    }, { parent: this });

    this.cpuCriticalAlarm = new aws.cloudwatch.MetricAlarm(`${name}-cpu-critical`, {
      name: `${config.deploymentName}-cpu-critical`,
      comparisonOperator: "GreaterThanThreshold",
      evaluationPeriods: 2,
      metricName: "node_cpu_utilization",
      namespace: "ContainerInsights",
      period: 60,
      statistic: "Average",
      threshold: config.cpuThresholdCritical,
      alarmDescription: `CRITICAL: CPU utilization exceeded ${config.cpuThresholdCritical}%`,
      dimensions: {
        ClusterName: config.clusterName,
      },
      alarmActions: [this.alertTopic.arn],
      okActions: [this.alertTopic.arn],
      treatMissingData: "notBreaching",
      tags: config.tags,
    }, { parent: this });

    this.memoryWarningAlarm = new aws.cloudwatch.MetricAlarm(`${name}-memory-warning`, {
      name: `${config.deploymentName}-memory-warning`,
      comparisonOperator: "GreaterThanThreshold",
      evaluationPeriods: 2,
      metricName: "node_memory_utilization",
      namespace: "ContainerInsights",
      period: 300,
      statistic: "Average",
      threshold: config.memoryThresholdWarning,
      alarmDescription: `Memory utilization exceeded ${config.memoryThresholdWarning}%`,
      dimensions: {
        ClusterName: config.clusterName,
      },
      alarmActions: [this.alertTopic.arn],
      okActions: [this.alertTopic.arn],
      treatMissingData: "notBreaching",
      tags: config.tags,
    }, { parent: this });

    this.memoryCriticalAlarm = new aws.cloudwatch.MetricAlarm(`${name}-memory-critical`, {
      name: `${config.deploymentName}-memory-critical`,
      comparisonOperator: "GreaterThanThreshold",
      evaluationPeriods: 2,
      metricName: "node_memory_utilization",
      namespace: "ContainerInsights",
      period: 60,
      statistic: "Average",
      threshold: config.memoryThresholdCritical,
      alarmDescription: `CRITICAL: Memory utilization exceeded ${config.memoryThresholdCritical}%`,
      dimensions: {
        ClusterName: config.clusterName,
      },
      alarmActions: [this.alertTopic.arn],
      okActions: [this.alertTopic.arn],
      treatMissingData: "notBreaching",
      tags: config.tags,
    }, { parent: this });

    this.podCountAlarm = new aws.cloudwatch.MetricAlarm(`${name}-pod-count`, {
      name: `${config.deploymentName}-pod-count-low`,
      comparisonOperator: "LessThanThreshold",
      evaluationPeriods: 2,
      metricName: "pod_number_of_running_pods",
      namespace: "ContainerInsights",
      period: 60,
      statistic: "Average",
      threshold: 1,
      alarmDescription: "CRITICAL: No running pods detected",
      dimensions: {
        ClusterName: config.clusterName,
        Namespace: config.namespace,
      },
      alarmActions: [this.alertTopic.arn],
      okActions: [this.alertTopic.arn],
      treatMissingData: "breaching",
      tags: config.tags,
    }, { parent: this });

    this.nodeCountAlarm = new aws.cloudwatch.MetricAlarm(`${name}-node-count`, {
      name: `${config.deploymentName}-node-count-low`,
      comparisonOperator: "LessThanThreshold",
      evaluationPeriods: 2,
      metricName: "cluster_node_count",
      namespace: "ContainerInsights",
      period: 60,
      statistic: "Average",
      threshold: 2,
      alarmDescription: "CRITICAL: Fewer than 2 nodes in cluster",
      dimensions: {
        ClusterName: config.clusterName,
      },
      alarmActions: [this.alertTopic.arn],
      okActions: [this.alertTopic.arn],
      treatMissingData: "breaching",
      tags: config.tags,
    }, { parent: this });

    const dashboardBody = JSON.stringify({
      widgets: [
        {
          type: "metric",
          x: 0, y: 0, width: 12, height: 6,
          properties: {
            title: "Node CPU Utilization",
            region: "us-west-2",
            metrics: [
              ["ContainerInsights", "node_cpu_utilization", "ClusterName", config.clusterName],
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
          x: 12, y: 0, width: 12, height: 6,
          properties: {
            title: "Node Memory Utilization",
            region: "us-west-2",
            metrics: [
              ["ContainerInsights", "node_memory_utilization", "ClusterName", config.clusterName],
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
          x: 0, y: 6, width: 12, height: 6,
          properties: {
            title: "Running Pods",
            region: "us-west-2",
            metrics: [
              ["ContainerInsights", "pod_number_of_running_pods", "ClusterName", config.clusterName, "Namespace", config.namespace],
            ],
            period: 60,
            stat: "Average",
          },
        },
        {
          type: "metric",
          x: 12, y: 6, width: 12, height: 6,
          properties: {
            title: "Node Count",
            region: "us-west-2",
            metrics: [
              ["ContainerInsights", "cluster_node_count", "ClusterName", config.clusterName],
            ],
            period: 60,
            stat: "Average",
          },
        },
        {
          type: "metric",
          x: 0, y: 12, width: 12, height: 6,
          properties: {
            title: "Pod CPU Utilization",
            region: "us-west-2",
            metrics: [
              ["ContainerInsights", "pod_cpu_utilization", "ClusterName", config.clusterName, "Namespace", config.namespace],
            ],
            period: 60,
            stat: "Average",
          },
        },
        {
          type: "metric",
          x: 12, y: 12, width: 12, height: 6,
          properties: {
            title: "Pod Memory Utilization",
            region: "us-west-2",
            metrics: [
              ["ContainerInsights", "pod_memory_utilization", "ClusterName", config.clusterName, "Namespace", config.namespace],
            ],
            period: 60,
            stat: "Average",
          },
        },
        {
          type: "metric",
          x: 0, y: 18, width: 24, height: 6,
          properties: {
            title: "Network IO",
            region: "us-west-2",
            metrics: [
              ["ContainerInsights", "pod_network_rx_bytes", "ClusterName", config.clusterName, "Namespace", config.namespace],
              ["ContainerInsights", "pod_network_tx_bytes", "ClusterName", config.clusterName, "Namespace", config.namespace],
            ],
            period: 60,
            stat: "Average",
          },
        },
      ],
    });

    this.dashboard = new aws.cloudwatch.Dashboard(`${name}-dashboard`, {
      dashboardName: `${config.deploymentName}-${config.environment}`,
      dashboardBody: dashboardBody,
    }, { parent: this });

    this.registerOutputs({
      alertTopicArn: this.alertTopic.arn,
      dashboardArn: this.dashboard.dashboardArn,
    });
  }
}
