# ECS Auto-Scaling Configuration

## Overview

The backend runs on AWS ECS with two services:
- **API Service** (`suna-api-svc`) - Stateless FastAPI containers
- **Worker Service** (`suna-worker-svc`) - Dramatiq workers processing agent runs

## Current Scaling Configuration

### API Service
| Setting | Value |
|---------|-------|
| Min capacity | 2 |
| Max capacity | 12 |
| Scale triggers | CPU > 90% OR Memory > 90% |

### Worker Service
| Setting | Value |
|---------|-------|
| Min capacity | 2 |
| Max capacity | 20 |
| Scale triggers | CPU > 90% OR Memory > 90% OR **Queue depth > 10** |

Each worker container runs `4 processes × 4 threads = 16 parallel jobs`.

## Queue-Based Scaling

Workers scale based on Dramatiq queue depth in Redis. This is more accurate than CPU/Memory for I/O-heavy workloads (LLM API calls).

### How It Works

1. **API publishes metric** - Background task in API containers publishes `DramatiqQueueDepth` to CloudWatch every 60 seconds
2. **CloudWatch alarm triggers** - When queue depth exceeds target (10 jobs per worker), alarm fires
3. **ECS scales workers** - Auto-scaling adds worker containers

### CloudWatch Metric

- **Namespace**: `Kortix`
- **Metric Name**: `DramatiqQueueDepth`
- **Dimensions**: `Service=worker`

### Scaling Policy

```yaml
Policy: worker-queue-depth-scaling
Type: TargetTrackingScaling
TargetValue: 10.0  # Target 10 jobs per worker
ScaleOutCooldown: 30s  # React quickly to spikes
ScaleInCooldown: 300s  # Slow scale-in to avoid thrashing
```

## IAM Permissions

The ECS task role (`suna-task-role-7638c9b`) has:

```json
{
  "Action": "cloudwatch:PutMetricData",
  "Resource": "*",
  "Condition": {
    "StringEquals": {
      "cloudwatch:namespace": "Kortix"
    }
  }
}
```

## Deployment Configuration

Fast deployments configured with:

| Setting | API Service | Worker Service |
|---------|-------------|----------------|
| minimumHealthyPercent | 50% | 50% |
| maximumPercent | 200% | 200% |
| healthCheckGracePeriod | 60s | 0s |

Target group deregistration delay: **30 seconds**

## Monitoring

### Endpoints

- `GET /api/metrics/queue` - Current queue depths
- `GET /api/health` - Basic health check
- `GET /api/health-docker` - Deep health check (Redis + DB)

### CloudWatch Dashboards

View metrics in CloudWatch:
- Namespace: `Kortix`
- Metrics: `DramatiqQueueDepth`

### CLI Commands

```bash
# Check current queue depth
curl https://api.suna.so/api/metrics/queue

# List CloudWatch metrics
aws cloudwatch list-metrics --namespace Kortix --region us-west-2

# Check scaling policies
aws application-autoscaling describe-scaling-policies \
  --service-namespace ecs \
  --resource-id service/suna-ecs/suna-worker-svc-8b51da8 \
  --region us-west-2

# Check current service status
aws ecs describe-services --cluster suna-ecs \
  --services suna-api-svc-5643fd4 suna-worker-svc-8b51da8 \
  --region us-west-2 \
  --query 'services[*].{name:serviceName,desired:desiredCount,running:runningCount}'
```

## Architecture

```
┌─────────────┐     HTTP      ┌─────────────────────────┐
│   Clients   │──────────────▶│  API Service (2-12)     │
└─────────────┘               │  - FastAPI              │
                              │  - Publishes queue metric│
                              └───────────┬─────────────┘
                                          │
                                          │ LPUSH
                                          ▼
                              ┌─────────────────────────┐
                              │   Redis (ElastiCache)   │
                              │   - Dramatiq broker     │
                              └───────────┬─────────────┘
                                          │
                                          │ BRPOP
                                          ▼
                              ┌─────────────────────────┐
                              │  Worker Service (2-20)  │
                              │  - 16 parallel/container│
                              │  - Scales on queue depth│
                              └─────────────────────────┘
```

