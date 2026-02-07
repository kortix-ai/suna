# Suna Infrastructure

Pulumi Infrastructure-as-Code for Suna

## Architecture

```
                    ┌─────────────────────────────────────────────────────────┐
                    │                    CLOUDFLARE                            │
                    │                                                          │
                    │   api.kortix.com ──► Worker (api-kortix-router)          │
                    │                          │                               │
                    │         ┌────────────────┴────────────────┐              │
                    │         ▼                                 ▼              │
                    │   ACTIVE_BACKEND=lightsail          (future: ecs)        │
                    │         │                                 │              │
                    │         ▼                                 ▼              │
                    │   api-lightsail.kortix.com         api-ecs.kortix.com    │
                    │   (Tunnel)                         (Direct to ALB)       │
                    └─────────┬─────────────────────────────────┬──────────────┘
                              │                                 │
                              ▼                                 ▼
┌─────────────────────────────────────────┐    ┌───────────────────────────────────┐
│         LIGHTSAIL (Prod)                │    │           ECS (Prod)              │
│   Cloudflared → localhost:8000          │    │   Cluster: suna-ecs               │
│                                         │    │   Fargate + Fargate Spot          │
└─────────────────────────────────────────┘    │   Auto-scaling (CPU/Memory)       │
                                               │   ALB → Target Group → Tasks      │
                                               └───────────────────────────────────┘
```

## Features

- **ECS on EC2**: Container orchestration on cost-efficient EC2 instances
- **Graviton (ARM)**: 20% cheaper than x86 instances
- **Spot Instances**: 70% cheaper than On-Demand
- **Auto-scaling**: CPU and memory-based target tracking (tasks + instances)
- **Scheduled Scaling**: Peak/off-peak capacity management
- **Monitoring**: CloudWatch dashboards and alarms
- **Alerts**: SNS notifications for CPU, memory, errors, latency
- **Disaster Recovery**: AWS Backup with configurable retention
- **Security**: Secrets Manager integration, no hardcoded credentials

## Quick Start

### Prerequisites

- [Pulumi CLI](https://www.pulumi.com/docs/install/)
- [AWS CLI](https://aws.amazon.com/cli/) configured
- Node.js 18+

### Setup

```bash
cd infra
npm install

# For production
cd environments/prod
../scripts/setup-prod-config.sh
```

### Deploy

```bash
# Preview changes
pulumi preview

# Deploy
pulumi up
```

## Configuration

All sensitive values are stored in Pulumi config (encrypted). See `Pulumi.prod.yaml.example` for required values.

### Required Secrets (use --secret flag)

| Key | Description |
|-----|-------------|
| `secretsManagerArn` | AWS Secrets Manager ARN for environment variables |
| `cloudflareTunnelId` | Cloudflare Tunnel ID |

### Required Configuration

| Key | Description |
|-----|-------------|
| `vpcId` | VPC ID |
| `privateSubnets` | Private subnet IDs (JSON array) |
| `publicSubnets` | Public subnet IDs (JSON array) |
| `albSecurityGroupId` | ALB security group ID |
| `ecsSecurityGroupId` | ECS tasks security group ID |
| `targetGroupArn` | ALB target group ARN |
| `loadBalancerArn` | ALB ARN |
| `albDnsName` | ALB DNS name |
| `containerImage` | ECR image URL |
| `lightsailKeyPairName` | SSH key pair name |
| `alertEmails` | Alert email addresses (JSON array) |

### Optional Configuration

See `Pulumi.prod.yaml.example` for all optional settings with defaults.

## Autoscaling

### Target Tracking (Automatic)

- **CPU**: Scales when average CPU > 70%
- **Memory**: Scales when average memory > 75%
- **Scale-out cooldown**: 60 seconds (fast response)
- **Scale-in cooldown**: 300 seconds (prevent flapping)

### Scheduled Scaling

- **Peak hours** (Mon-Fri 6AM-6PM PT): 3-10 tasks
- **Off-peak**: 2-6 tasks

### Cost Optimization

- **Graviton ARM instances** (t4g, c6g): 20% cheaper than x86
- **Spot instances**: 70% cheaper than On-Demand
- **On-Demand base**: 1 instance for stability
- **Spot above base**: 100% (all additional capacity)
- **Binpack placement**: Maximize instance utilization
- **Memory overcommit**: Soft limits allow efficient packing

**Estimated monthly costs (us-west-2):**
| Setup | Cost |
|-------|------|
| 2x t4g.medium On-Demand | ~$49/mo |
| 2x t4g.medium Spot | ~$15/mo |
| 1 On-Demand + 1 Spot | ~$32/mo |

## Monitoring

### CloudWatch Alarms

| Alarm | Threshold | Severity |
|-------|-----------|----------|
| CPU Warning | > 70% | Warning |
| CPU Critical | > 85% | Critical |
| Memory Warning | > 75% | Warning |
| Memory Critical | > 90% | Critical |
| No Running Tasks | < 1 | Critical |
| High Latency | P99 > 2000ms | Warning |
| High Error Rate | > 5% | Warning |

### Dashboard

Access via AWS Console or exported URL in `pulumi stack output`.

## Disaster Recovery

- **Daily backups**: 30-day retention
- **Weekly backups**: 120-day retention
- **Cross-region**: Optional (disabled by default)

## Directory Structure

```
infra/
├── components/           # Reusable Pulumi components
│   ├── autoscaling/     # ECS autoscaling policies
│   ├── compute/         # EC2 capacity (ASG, launch template, capacity provider)
│   ├── disaster-recovery/ # Backup and failover
│   ├── ecs/             # ECS cluster, service, task definitions
│   ├── iam/             # IAM roles and policies
│   ├── monitoring/      # CloudWatch alarms and dashboards
│   └── types.ts         # TypeScript interfaces
├── environments/
│   ├── dev/
│   ├── staging/
│   └── prod/
│       ├── index.ts
│       ├── Pulumi.yaml
│       └── Pulumi.prod.yaml.example
└── scripts/
    └── setup-prod-config.sh
```

## Troubleshooting

### Common Issues

1. **Permission denied**: Ensure AWS credentials have required permissions
2. **Resource already exists**: Import existing resources with `pulumi import`
3. **Secret not found**: Run `pulumi config set --secret <key> <value>`

### Useful Commands

```bash
# View current config
pulumi config

# View stack outputs
pulumi stack output

# Destroy infrastructure
pulumi destroy

# Import existing resource
pulumi import aws:ecs/cluster:Cluster suna-ecs arn:aws:ecs:...
```
