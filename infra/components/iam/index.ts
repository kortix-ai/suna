import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export class EcsIamRoles extends pulumi.ComponentResource {
  public readonly executionRole: aws.iam.Role;
  public readonly taskRole: aws.iam.Role;
  public readonly executionRoleArn: pulumi.Output<string>;
  public readonly taskRoleArn: pulumi.Output<string>;

  constructor(
    name: string,
    config: {
      serviceName: string;
      secretsArn: pulumi.Input<string>;
      logGroupArn?: pulumi.Input<string>;
      tags?: Record<string, string>;
    },
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("suna:iam:EcsIamRoles", name, {}, opts);

    const assumeRolePolicy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Action: "sts:AssumeRole",
        Effect: "Allow",
        Principal: {
          Service: "ecs-tasks.amazonaws.com",
        },
      }],
    });

    this.executionRole = new aws.iam.Role(`${name}-exec-role`, {
      name: `${config.serviceName}-exec-role`,
      assumeRolePolicy: assumeRolePolicy,
      tags: config.tags,
    }, { parent: this });

    new aws.iam.RolePolicyAttachment(`${name}-exec-policy`, {
      role: this.executionRole.name,
      policyArn: "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
    }, { parent: this });

    const execSecretsPolicy = pulumi.output(config.secretsArn).apply(secretsArn => JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: [
            "secretsmanager:GetSecretValue",
          ],
          Resource: [
            secretsArn,
            `${secretsArn}:*`,
          ],
        },
        {
          Effect: "Allow",
          Action: [
            "logs:CreateLogStream",
            "logs:PutLogEvents",
            "logs:CreateLogGroup",
          ],
          Resource: "*",
        },
        {
          Effect: "Allow",
          Action: [
            "ecr:GetAuthorizationToken",
            "ecr:BatchCheckLayerAvailability",
            "ecr:GetDownloadUrlForLayer",
            "ecr:BatchGetImage",
          ],
          Resource: "*",
        },
      ],
    }));

    new aws.iam.RolePolicy(`${name}-exec-secrets`, {
      name: `${config.serviceName}-secrets-access`,
      role: this.executionRole.id,
      policy: execSecretsPolicy,
    }, { parent: this });

    this.taskRole = new aws.iam.Role(`${name}-task-role`, {
      name: `${config.serviceName}-task-role`,
      assumeRolePolicy: assumeRolePolicy,
      tags: config.tags,
    }, { parent: this });

    const taskPolicy = pulumi.output(config.secretsArn).apply(secretsArn => JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: [
            "ssmmessages:CreateControlChannel",
            "ssmmessages:CreateDataChannel",
            "ssmmessages:OpenControlChannel",
            "ssmmessages:OpenDataChannel",
          ],
          Resource: "*",
        },
        {
          Effect: "Allow",
          Action: [
            "logs:DescribeLogGroups",
          ],
          Resource: "*",
        },
        {
          Effect: "Allow",
          Action: [
            "s3:GetObject",
            "s3:PutObject",
            "s3:ListBucket",
          ],
          Resource: [
            "arn:aws:s3:::suna-*",
            "arn:aws:s3:::suna-*/*",
          ],
        },
        {
          Effect: "Allow",
          Action: [
            "secretsmanager:GetSecretValue",
          ],
          Resource: secretsArn,
        },
      ],
    }));

    new aws.iam.RolePolicy(`${name}-task-policy`, {
      name: `${config.serviceName}-task-permissions`,
      role: this.taskRole.id,
      policy: taskPolicy,
    }, { parent: this });

    this.executionRoleArn = this.executionRole.arn;
    this.taskRoleArn = this.taskRole.arn;

    this.registerOutputs({
      executionRoleArn: this.executionRoleArn,
      taskRoleArn: this.taskRoleArn,
    });
  }
}
