import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { TaskDefinitionConfig } from "../types";

export interface Ec2TaskDefinitionConfig {
  family: string;
  cpu: number;
  memory: number;
  memoryReservation: number;
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

export class EcsTaskDefinition extends pulumi.ComponentResource {
  public readonly taskDefinition: aws.ecs.TaskDefinition;
  public readonly taskDefinitionArn: pulumi.Output<string>;
  public readonly logGroup: aws.cloudwatch.LogGroup;

  constructor(name: string, config: TaskDefinitionConfig, opts?: pulumi.ComponentResourceOptions) {
    super("suna:ecs:TaskDefinition", name, {}, opts);

    this.logGroup = new aws.cloudwatch.LogGroup(`${name}-logs`, {
      name: `/ecs/${config.family}`,
      retentionInDays: config.logRetentionDays,
      tags: {
        ...config.tags,
        Environment: config.environment,
      },
    }, { parent: this });

    const containerDefinitions = pulumi.all([this.logGroup.name, config.secretsArn]).apply(([logGroupName, secretsArn]) => JSON.stringify([{
      name: config.containerName,
      image: config.containerImage,
      cpu: config.cpu,
      memory: config.memory,
      essential: true,
      portMappings: [{
        containerPort: config.containerPort,
        hostPort: config.containerPort,
        protocol: "tcp",
      }],
      healthCheck: {
        command: ["CMD-SHELL", `curl -f http://localhost:${config.containerPort}${config.healthCheckPath} || exit 1`],
        interval: 30,
        timeout: 5,
        retries: 3,
        startPeriod: 60,
      },
      secrets: [{
        name: "SUNA_ENV_JSON",
        valueFrom: secretsArn,
      }],
      logConfiguration: {
        logDriver: "awslogs",
        options: {
          "awslogs-group": logGroupName,
          "awslogs-region": "us-west-2",
          "awslogs-stream-prefix": "ecs",
        },
      },
      ulimits: [{
        name: "nofile",
        softLimit: 65536,
        hardLimit: 65536,
      }],
    }]));

    this.taskDefinition = new aws.ecs.TaskDefinition(name, {
      family: config.family,
      networkMode: "awsvpc",
      requiresCompatibilities: ["FARGATE"],
      cpu: config.cpu.toString(),
      memory: config.memory.toString(),
      executionRoleArn: config.executionRoleArn,
      taskRoleArn: config.taskRoleArn,
      containerDefinitions: containerDefinitions,
      runtimePlatform: {
        operatingSystemFamily: "LINUX",
        cpuArchitecture: "X86_64",
      },
      tags: {
        ...config.tags,
        Environment: config.environment,
      },
    }, { parent: this });

    this.taskDefinitionArn = this.taskDefinition.arn;

    this.registerOutputs({
      taskDefinitionArn: this.taskDefinitionArn,
      logGroupName: this.logGroup.name,
    });
  }
}

export class Ec2TaskDefinition extends pulumi.ComponentResource {
  public readonly taskDefinition: aws.ecs.TaskDefinition;
  public readonly taskDefinitionArn: pulumi.Output<string>;
  public readonly logGroup: aws.cloudwatch.LogGroup;

  constructor(name: string, config: Ec2TaskDefinitionConfig, opts?: pulumi.ComponentResourceOptions) {
    super("suna:ecs:Ec2TaskDefinition", name, {}, opts);

    this.logGroup = new aws.cloudwatch.LogGroup(`${name}-logs`, {
      name: `/ecs/${config.family}`,
      retentionInDays: config.logRetentionDays,
      tags: {
        ...config.tags,
        Environment: config.environment,
      },
    }, { parent: this });

    const containerDefinitions = pulumi.all([this.logGroup.name, config.secretsArn]).apply(([logGroupName, secretsArn]) => JSON.stringify([{
      name: config.containerName,
      image: config.containerImage,
      cpu: config.cpu,
      memory: config.memory,
      memoryReservation: config.memoryReservation,
      essential: true,
      portMappings: [{
        containerPort: config.containerPort,
        hostPort: 0,
        protocol: "tcp",
      }],
      healthCheck: {
        command: ["CMD-SHELL", `curl -f http://localhost:${config.containerPort}${config.healthCheckPath} || exit 1`],
        interval: 30,
        timeout: 5,
        retries: 3,
        startPeriod: 60,
      },
      secrets: [{
        name: "SUNA_ENV_JSON",
        valueFrom: secretsArn,
      }],
      logConfiguration: {
        logDriver: "awslogs",
        options: {
          "awslogs-group": logGroupName,
          "awslogs-region": "us-west-2",
          "awslogs-stream-prefix": "ecs",
        },
      },
      ulimits: [{
        name: "nofile",
        softLimit: 65536,
        hardLimit: 65536,
      }],
    }]));

    this.taskDefinition = new aws.ecs.TaskDefinition(name, {
      family: config.family,
      networkMode: "bridge",
      requiresCompatibilities: ["EC2"],
      executionRoleArn: config.executionRoleArn,
      taskRoleArn: config.taskRoleArn,
      containerDefinitions: containerDefinitions,
      tags: {
        ...config.tags,
        Environment: config.environment,
      },
    }, { parent: this });

    this.taskDefinitionArn = this.taskDefinition.arn;

    this.registerOutputs({
      taskDefinitionArn: this.taskDefinitionArn,
      logGroupName: this.logGroup.name,
    });
  }
}

export interface HybridTaskDefinitionConfig {
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
  region: string;
  executionRoleArn: pulumi.Input<string>;
  taskRoleArn: pulumi.Input<string>;
  tags?: Record<string, string>;
}

export class HybridTaskDefinition extends pulumi.ComponentResource {
  public readonly taskDefinition: aws.ecs.TaskDefinition;
  public readonly taskDefinitionArn: pulumi.Output<string>;
  public readonly logGroup: aws.cloudwatch.LogGroup;

  constructor(name: string, config: HybridTaskDefinitionConfig, opts?: pulumi.ComponentResourceOptions) {
    super("suna:ecs:HybridTaskDefinition", name, {}, opts);

    this.logGroup = new aws.cloudwatch.LogGroup(`${name}-logs`, {
      name: `/ecs/${config.family}`,
      retentionInDays: config.logRetentionDays,
      tags: {
        ...config.tags,
        Environment: config.environment,
      },
    }, { parent: this });

    const containerDefinitions = pulumi.all([this.logGroup.name, config.secretsArn]).apply(([logGroupName, secretsArn]) => JSON.stringify([{
      name: config.containerName,
      image: config.containerImage,
      cpu: config.cpu,
      memory: config.memory,
      essential: true,
      portMappings: [{
        containerPort: config.containerPort,
        hostPort: config.containerPort,
        protocol: "tcp",
      }],
      healthCheck: {
        command: ["CMD-SHELL", `curl -f http://localhost:${config.containerPort}${config.healthCheckPath} || exit 1`],
        interval: 30,
        timeout: 5,
        retries: 3,
        startPeriod: 60,
      },
      secrets: [{
        name: "SUNA_ENV_JSON",
        valueFrom: secretsArn,
      }],
      logConfiguration: {
        logDriver: "awslogs",
        options: {
          "awslogs-group": logGroupName,
          "awslogs-region": config.region,
          "awslogs-stream-prefix": "ecs",
        },
      },
      ulimits: [{
        name: "nofile",
        softLimit: 65536,
        hardLimit: 65536,
      }],
      stopTimeout: 120,
    }]));

    this.taskDefinition = new aws.ecs.TaskDefinition(name, {
      family: config.family,
      networkMode: "awsvpc",
      requiresCompatibilities: ["EC2", "FARGATE"],
      cpu: config.cpu.toString(),
      memory: config.memory.toString(),
      executionRoleArn: config.executionRoleArn,
      taskRoleArn: config.taskRoleArn,
      containerDefinitions: containerDefinitions,
      runtimePlatform: {
        operatingSystemFamily: "LINUX",
        cpuArchitecture: "ARM64",
      },
      tags: {
        ...config.tags,
        Environment: config.environment,
      },
    }, { parent: this });

    this.taskDefinitionArn = this.taskDefinition.arn;

    this.registerOutputs({
      taskDefinitionArn: this.taskDefinitionArn,
      logGroupName: this.logGroup.name,
    });
  }
}
