import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export class EksIamRoles extends pulumi.ComponentResource {
  public readonly nodeRole: aws.iam.Role;
  public readonly podRole: aws.iam.Role;
  public readonly nodeRoleArn: pulumi.Output<string>;
  public readonly podRoleArn: pulumi.Output<string>;
  public readonly nodeInstanceProfile: aws.iam.InstanceProfile;

  constructor(
    name: string,
    config: {
      serviceName: string;
      secretsArn: pulumi.Input<string>;
      tags?: Record<string, string>;
    },
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("suna:iam:EksIamRoles", name, {}, opts);

    this.nodeRole = new aws.iam.Role(`${name}-node-role`, {
      name: `${config.serviceName}-eks-node-role`,
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

    const nodePolicies = [
      "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
      "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
      "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
      "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
      "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy",
    ];

    nodePolicies.forEach((policyArn, index) => {
      new aws.iam.RolePolicyAttachment(`${name}-node-policy-${index}`, {
        role: this.nodeRole.name,
        policyArn,
      }, { parent: this });
    });

    this.nodeInstanceProfile = new aws.iam.InstanceProfile(`${name}-node-profile`, {
      name: `${config.serviceName}-eks-node-profile`,
      role: this.nodeRole.name,
    }, { parent: this });

    this.podRole = new aws.iam.Role(`${name}-pod-role`, {
      name: `${config.serviceName}-eks-pod-role`,
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

    const podPolicy = pulumi.output(config.secretsArn).apply(secretsArn => JSON.stringify({
      Version: "2012-10-17",
      Statement: [
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
          Resource: [
            secretsArn,
            `${secretsArn}:*`,
          ],
        },
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
            "logs:CreateLogGroup",
            "logs:CreateLogStream",
            "logs:PutLogEvents",
            "logs:DescribeLogGroups",
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

    new aws.iam.RolePolicy(`${name}-pod-policy`, {
      name: `${config.serviceName}-pod-permissions`,
      role: this.podRole.id,
      policy: podPolicy,
    }, { parent: this });

    this.nodeRoleArn = this.nodeRole.arn;
    this.podRoleArn = this.podRole.arn;

    this.registerOutputs({
      nodeRoleArn: this.nodeRoleArn,
      podRoleArn: this.podRoleArn,
    });
  }
}

export class ClusterAutoscalerIamRole extends pulumi.ComponentResource {
  public readonly role: aws.iam.Role;
  public readonly roleArn: pulumi.Output<string>;

  constructor(
    name: string,
    config: {
      clusterName: string;
      oidcProviderArn: pulumi.Input<string>;
      oidcProviderUrl: pulumi.Input<string>;
      namespace: string;
      serviceAccountName: string;
      tags?: Record<string, string>;
    },
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("suna:iam:ClusterAutoscalerIamRole", name, {}, opts);

    const assumeRolePolicy = pulumi
      .all([config.oidcProviderArn, config.oidcProviderUrl])
      .apply(([arn, url]) => {
        const issuer = url.replace("https://", "");
        return JSON.stringify({
          Version: "2012-10-17",
          Statement: [{
            Effect: "Allow",
            Principal: { Federated: arn },
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: {
              StringEquals: {
                [`${issuer}:aud`]: "sts.amazonaws.com",
                [`${issuer}:sub`]: `system:serviceaccount:${config.namespace}:${config.serviceAccountName}`,
              },
            },
          }],
        });
      });

    this.role = new aws.iam.Role(`${name}-role`, {
      name: `${config.clusterName}-cluster-autoscaler-role`,
      assumeRolePolicy,
      tags: config.tags,
    }, { parent: this });

    const policy = new aws.iam.Policy(`${name}-policy`, {
      name: `${config.clusterName}-cluster-autoscaler-policy`,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "autoscaling:DescribeAutoScalingGroups",
              "autoscaling:DescribeAutoScalingInstances",
              "autoscaling:DescribeLaunchConfigurations",
              "autoscaling:DescribeScalingActivities",
              "autoscaling:DescribeTags",
              "ec2:DescribeImages",
              "ec2:DescribeInstanceTypes",
              "ec2:DescribeLaunchTemplateVersions",
              "ec2:GetInstanceTypesFromInstanceRequirements",
              "eks:DescribeNodegroup",
            ],
            Resource: "*",
          },
          {
            Effect: "Allow",
            Action: [
              "autoscaling:SetDesiredCapacity",
              "autoscaling:TerminateInstanceInAutoScalingGroup",
            ],
            Resource: "*",
            Condition: {
              StringEquals: {
                [`aws:ResourceTag/k8s.io/cluster-autoscaler/${config.clusterName}`]: "owned",
              },
            },
          },
        ],
      }),
      tags: config.tags,
    }, { parent: this });

    new aws.iam.RolePolicyAttachment(`${name}-attachment`, {
      role: this.role.name,
      policyArn: policy.arn,
    }, { parent: this });

    this.roleArn = this.role.arn;

    this.registerOutputs({ roleArn: this.roleArn });
  }
}

export class AlbControllerIamRole extends pulumi.ComponentResource {
  public readonly role: aws.iam.Role;
  public readonly roleArn: pulumi.Output<string>;

  constructor(
    name: string,
    config: {
      clusterName: string;
      oidcProviderArn: pulumi.Input<string>;
      oidcProviderUrl: pulumi.Input<string>;
      namespace: string;
      serviceAccountName: string;
      tags?: Record<string, string>;
    },
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("suna:iam:AlbControllerIamRole", name, {}, opts);

    const assumeRolePolicy = pulumi
      .all([config.oidcProviderArn, config.oidcProviderUrl])
      .apply(([arn, url]) => {
        const issuer = url.replace("https://", "");
        return JSON.stringify({
          Version: "2012-10-17",
          Statement: [{
            Effect: "Allow",
            Principal: {
              Federated: arn,
            },
            Action: "sts:AssumeRoleWithWebIdentity",
            Condition: {
              StringEquals: {
                [`${issuer}:aud`]: "sts.amazonaws.com",
                [`${issuer}:sub`]: `system:serviceaccount:${config.namespace}:${config.serviceAccountName}`,
              },
            },
          }],
        });
      });

    this.role = new aws.iam.Role(`${name}-alb-role`, {
      name: `${config.clusterName}-alb-controller-role`,
      assumeRolePolicy,
      tags: config.tags,
    }, { parent: this });

    const albPolicy = new aws.iam.Policy(`${name}-alb-policy`, {
      name: `${config.clusterName}-alb-controller-policy`,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "iam:CreateServiceLinkedRole",
            ],
            Resource: "*",
            Condition: {
              StringEquals: {
                "iam:AWSServiceName": "elasticloadbalancing.amazonaws.com",
              },
            },
          },
          {
            Effect: "Allow",
            Action: [
              "ec2:DescribeAccountAttributes",
              "ec2:DescribeAddresses",
              "ec2:DescribeAvailabilityZones",
              "ec2:DescribeInternetGateways",
              "ec2:DescribeVpcs",
              "ec2:DescribeVpcPeeringConnections",
              "ec2:DescribeSubnets",
              "ec2:DescribeSecurityGroups",
              "ec2:DescribeInstances",
              "ec2:DescribeNetworkInterfaces",
              "ec2:DescribeTags",
              "ec2:DescribeCoipPools",
              "ec2:GetCoipPoolUsage",
              "ec2:DescribeInstanceTypes",
              "elasticloadbalancing:DescribeLoadBalancers",
              "elasticloadbalancing:DescribeLoadBalancerAttributes",
              "elasticloadbalancing:DescribeListeners",
              "elasticloadbalancing:DescribeListenerCertificates",
              "elasticloadbalancing:DescribeSSLPolicies",
              "elasticloadbalancing:DescribeRules",
              "elasticloadbalancing:DescribeTargetGroups",
              "elasticloadbalancing:DescribeTargetGroupAttributes",
              "elasticloadbalancing:DescribeTargetHealth",
              "elasticloadbalancing:DescribeTags",
              "elasticloadbalancing:DescribeTrustStores",
              "elasticloadbalancing:DescribeListenerAttributes",
            ],
            Resource: "*",
          },
          {
            Effect: "Allow",
            Action: [
              "cognito-idp:DescribeUserPoolClient",
              "acm:ListCertificates",
              "acm:DescribeCertificate",
              "iam:ListServerCertificates",
              "iam:GetServerCertificate",
              "waf-regional:GetWebACL",
              "waf-regional:GetWebACLForResource",
              "waf-regional:AssociateWebACL",
              "waf-regional:DisassociateWebACL",
              "wafv2:GetWebACL",
              "wafv2:GetWebACLForResource",
              "wafv2:AssociateWebACL",
              "wafv2:DisassociateWebACL",
              "shield:GetSubscriptionState",
              "shield:DescribeProtection",
              "shield:CreateProtection",
              "shield:DeleteProtection",
            ],
            Resource: "*",
          },
          {
            Effect: "Allow",
            Action: [
              "ec2:AuthorizeSecurityGroupIngress",
              "ec2:RevokeSecurityGroupIngress",
              "ec2:CreateSecurityGroup",
            ],
            Resource: "*",
          },
          {
            Effect: "Allow",
            Action: [
              "ec2:CreateTags",
            ],
            Resource: "arn:aws:ec2:*:*:security-group/*",
            Condition: {
              Null: {
                "aws:RequestTag/elbv2.k8s.aws/cluster": "false",
              },
              StringEquals: {
                "ec2:CreateAction": "CreateSecurityGroup",
              },
            },
          },
          {
            Effect: "Allow",
            Action: [
              "ec2:CreateTags",
              "ec2:DeleteTags",
            ],
            Resource: "arn:aws:ec2:*:*:security-group/*",
            Condition: {
              Null: {
                "aws:RequestTag/elbv2.k8s.aws/cluster": "false",
                "aws:ResourceTag/elbv2.k8s.aws/cluster": "false",
              },
            },
          },
          {
            Effect: "Allow",
            Action: [
              "ec2:DeleteSecurityGroup",
            ],
            Resource: "*",
            Condition: {
              Null: {
                "aws:ResourceTag/elbv2.k8s.aws/cluster": "false",
              },
            },
          },
          {
            Effect: "Allow",
            Action: [
              "elasticloadbalancing:CreateLoadBalancer",
              "elasticloadbalancing:CreateTargetGroup",
            ],
            Resource: "*",
            Condition: {
              Null: {
                "aws:RequestTag/elbv2.k8s.aws/cluster": "false",
              },
            },
          },
          {
            Effect: "Allow",
            Action: [
              "elasticloadbalancing:CreateListener",
              "elasticloadbalancing:DeleteListener",
              "elasticloadbalancing:CreateRule",
              "elasticloadbalancing:DeleteRule",
            ],
            Resource: "*",
          },
          {
            Effect: "Allow",
            Action: [
              "elasticloadbalancing:AddTags",
            ],
            Resource: [
              "arn:aws:elasticloadbalancing:*:*:targetgroup/*/*",
              "arn:aws:elasticloadbalancing:*:*:loadbalancer/net/*/*",
              "arn:aws:elasticloadbalancing:*:*:loadbalancer/app/*/*",
            ],
            Condition: {
              Null: {
                "aws:RequestTag/elbv2.k8s.aws/cluster": "false",
              },
            },
          },
          {
            Effect: "Allow",
            Action: [
              "elasticloadbalancing:AddTags",
              "elasticloadbalancing:RemoveTags",
            ],
            Resource: [
              "arn:aws:elasticloadbalancing:*:*:targetgroup/*/*",
              "arn:aws:elasticloadbalancing:*:*:loadbalancer/net/*/*",
              "arn:aws:elasticloadbalancing:*:*:loadbalancer/app/*/*",
            ],
            Condition: {
              Null: {
                "aws:RequestTag/elbv2.k8s.aws/cluster": "true",
                "aws:ResourceTag/elbv2.k8s.aws/cluster": "false",
              },
            },
          },
          {
            Effect: "Allow",
            Action: [
              "elasticloadbalancing:AddTags",
              "elasticloadbalancing:RemoveTags",
            ],
            Resource: [
              "arn:aws:elasticloadbalancing:*:*:listener/net/*/*/*",
              "arn:aws:elasticloadbalancing:*:*:listener/app/*/*/*",
              "arn:aws:elasticloadbalancing:*:*:listener-rule/net/*/*/*",
              "arn:aws:elasticloadbalancing:*:*:listener-rule/app/*/*/*",
            ],
          },
          {
            Effect: "Allow",
            Action: [
              "elasticloadbalancing:ModifyLoadBalancerAttributes",
              "elasticloadbalancing:SetIpAddressType",
              "elasticloadbalancing:SetSecurityGroups",
              "elasticloadbalancing:SetSubnets",
              "elasticloadbalancing:DeleteLoadBalancer",
              "elasticloadbalancing:ModifyTargetGroup",
              "elasticloadbalancing:ModifyTargetGroupAttributes",
              "elasticloadbalancing:DeleteTargetGroup",
            ],
            Resource: "*",
            Condition: {
              Null: {
                "aws:ResourceTag/elbv2.k8s.aws/cluster": "false",
              },
            },
          },
          {
            Effect: "Allow",
            Action: [
              "elasticloadbalancing:RegisterTargets",
              "elasticloadbalancing:DeregisterTargets",
            ],
            Resource: "arn:aws:elasticloadbalancing:*:*:targetgroup/*/*",
          },
          {
            Effect: "Allow",
            Action: [
              "elasticloadbalancing:SetWebAcl",
              "elasticloadbalancing:ModifyListener",
              "elasticloadbalancing:AddListenerCertificates",
              "elasticloadbalancing:RemoveListenerCertificates",
              "elasticloadbalancing:ModifyRule",
            ],
            Resource: "*",
          },
        ],
      }),
      tags: config.tags,
    }, { parent: this });

    new aws.iam.RolePolicyAttachment(`${name}-alb-attachment`, {
      role: this.role.name,
      policyArn: albPolicy.arn,
    }, { parent: this });

    this.roleArn = this.role.arn;

    this.registerOutputs({
      roleArn: this.roleArn,
    });
  }
}
