import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export class DisasterRecovery extends pulumi.ComponentResource {
  public readonly backupVault: aws.backup.Vault;
  public readonly backupPlan: aws.backup.Plan;
  public readonly backupSelection: aws.backup.Selection;
  public readonly backupRole: aws.iam.Role;

  constructor(
    name: string,
    config: {
      serviceName: string;
      retentionDays: number;
      enableCrossRegion: boolean;
      secondaryRegion?: string;
      resourceArns: pulumi.Input<string>[];
      tags?: Record<string, string>;
    },
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("suna:dr:DisasterRecovery", name, {}, opts);

    this.backupVault = new aws.backup.Vault(`${name}-vault`, {
      name: `${config.serviceName}-backup-vault`,
      tags: config.tags,
    }, { parent: this });

    this.backupRole = new aws.iam.Role(`${name}-backup-role`, {
      name: `${config.serviceName}-backup-role`,
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Action: "sts:AssumeRole",
          Effect: "Allow",
          Principal: {
            Service: "backup.amazonaws.com",
          },
        }],
      }),
      tags: config.tags,
    }, { parent: this });

    new aws.iam.RolePolicyAttachment(`${name}-backup-policy`, {
      role: this.backupRole.name,
      policyArn: "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup",
    }, { parent: this });

    new aws.iam.RolePolicyAttachment(`${name}-restore-policy`, {
      role: this.backupRole.name,
      policyArn: "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores",
    }, { parent: this });

    const rules: aws.types.input.backup.PlanRule[] = [
      {
        ruleName: "daily-backup",
        targetVaultName: this.backupVault.name,
        schedule: "cron(0 5 ? * * *)",
        startWindow: 60,
        completionWindow: 120,
        lifecycle: {
          deleteAfter: config.retentionDays,
        },
      },
      {
        ruleName: "weekly-backup",
        targetVaultName: this.backupVault.name,
        schedule: "cron(0 5 ? * 1 *)",
        startWindow: 60,
        completionWindow: 180,
        lifecycle: {
          deleteAfter: config.retentionDays * 4,
        },
      },
    ];

    if (config.enableCrossRegion && config.secondaryRegion) {
      rules[0].copyActions = [{
        destinationVaultArn: pulumi.interpolate`arn:aws:backup:${config.secondaryRegion}:${aws.getCallerIdentityOutput().accountId}:backup-vault:${config.serviceName}-backup-vault-dr`,
        lifecycle: {
          deleteAfter: config.retentionDays,
        },
      }];
    }

    this.backupPlan = new aws.backup.Plan(`${name}-plan`, {
      name: `${config.serviceName}-backup-plan`,
      rules: rules,
      tags: config.tags,
    }, { parent: this });

    this.backupSelection = new aws.backup.Selection(`${name}-selection`, {
      name: `${config.serviceName}-backup-selection`,
      planId: this.backupPlan.id,
      iamRoleArn: this.backupRole.arn,
      resources: config.resourceArns,
    }, { parent: this });

    this.registerOutputs({
      backupVaultArn: this.backupVault.arn,
      backupPlanId: this.backupPlan.id,
    });
  }
}

export class MultiAzSetup extends pulumi.ComponentResource {
  public readonly subnets: pulumi.Output<string>[];
  public readonly availabilityZones: string[];

  constructor(
    name: string,
    config: {
      vpcId: string;
      region: string;
      cidrBlocks: string[];
      tags?: Record<string, string>;
    },
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("suna:dr:MultiAzSetup", name, {}, opts);

    this.availabilityZones = [
      `${config.region}a`,
      `${config.region}b`,
      `${config.region}c`,
    ];

    this.subnets = config.cidrBlocks.map((cidr, index) => {
      const subnet = new aws.ec2.Subnet(`${name}-subnet-${index}`, {
        vpcId: config.vpcId,
        cidrBlock: cidr,
        availabilityZone: this.availabilityZones[index % this.availabilityZones.length],
        tags: {
          ...config.tags,
          Name: `${name}-subnet-${this.availabilityZones[index % this.availabilityZones.length]}`,
        },
      }, { parent: this });
      return subnet.id;
    });

    this.registerOutputs({
      subnetIds: this.subnets,
      availabilityZones: this.availabilityZones,
    });
  }
}

export class FailoverAlarms extends pulumi.ComponentResource {
  public readonly serviceDownAlarm: aws.cloudwatch.MetricAlarm;
  public readonly compositeAlarm: aws.cloudwatch.CompositeAlarm;

  constructor(
    name: string,
    config: {
      serviceName: string;
      clusterName: string;
      alertTopicArn: pulumi.Input<string>;
      tags?: Record<string, string>;
    },
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("suna:dr:FailoverAlarms", name, {}, opts);

    this.serviceDownAlarm = new aws.cloudwatch.MetricAlarm(`${name}-service-down`, {
      name: `${config.serviceName}-service-down`,
      comparisonOperator: "LessThanThreshold",
      evaluationPeriods: 3,
      metricName: "RunningTaskCount",
      namespace: "ECS/ContainerInsights",
      period: 60,
      statistic: "Average",
      threshold: 1,
      alarmDescription: "CRITICAL: ECS service has no running tasks",
      dimensions: {
        ClusterName: config.clusterName,
        ServiceName: config.serviceName,
      },
      alarmActions: [config.alertTopicArn],
      okActions: [config.alertTopicArn],
      treatMissingData: "breaching",
      tags: config.tags,
    }, { parent: this });

    this.compositeAlarm = new aws.cloudwatch.CompositeAlarm(`${name}-composite`, {
      alarmName: `${config.serviceName}-critical-composite`,
      alarmDescription: "CRITICAL: Multiple service health indicators triggered",
      alarmRule: pulumi.interpolate`ALARM(${this.serviceDownAlarm.name})`,
      alarmActions: [config.alertTopicArn],
      okActions: [config.alertTopicArn],
      tags: config.tags,
    }, { parent: this });

    this.registerOutputs({
      serviceDownAlarmArn: this.serviceDownAlarm.arn,
      compositeAlarmArn: this.compositeAlarm.arn,
    });
  }
}
