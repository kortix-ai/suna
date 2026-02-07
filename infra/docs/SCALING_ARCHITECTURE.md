# Scaling Architecture for 10k+ Concurrent Agent Runs

## Architecture Overview

```
                                    ┌─────────────────────────────────────┐
                                    │         CloudFront / ALB            │
                                    └─────────────────┬───────────────────┘
                                                      │
                                    ┌─────────────────▼───────────────────┐
                                    │         API Gateway Layer           │
                                    │    (accepts requests, returns job ID)│
                                    └─────────────────┬───────────────────┘
                                                      │
                                    ┌─────────────────▼───────────────────┐
                                    │           SQS Queue                 │
                                    │    (buffers agent run requests)     │
                                    │    • Standard queue (high throughput)│
                                    │    • Message retention: 4 days      │
                                    │    • Visibility timeout: 15 min     │
                                    └─────────────────┬───────────────────┘
                                                      │
                    ┌─────────────────────────────────┼─────────────────────────────────┐
                    │                                 │                                 │
                    ▼                                 ▼                                 ▼
    ┌───────────────────────────┐   ┌───────────────────────────────┐   ┌───────────────────────────┐
    │     EC2 Spot Fleet        │   │     EC2 On-Demand Pool        │   │     Fargate Burst Pool    │
    │   (Primary Workers)       │   │   (Guaranteed Capacity)       │   │   (Instant Scaling)       │
    │                           │   │                               │   │                           │
    │   • 70% of capacity       │   │   • 20% of capacity           │   │   • 10% overflow          │
    │   • c6g/m6g instances     │   │   • c6g/m6g instances         │   │   • Fargate Spot primary  │
    │   • Auto-scales 0-200     │   │   • Fixed 30-50 instances     │   │   • On-Demand fallback    │
    │   • ~$0.03/task-hour      │   │   • ~$0.10/task-hour          │   │   • ~$0.15/task-hour      │
    └───────────────────────────┘   └───────────────────────────────┘   └───────────────────────────┘
```

## Why Queue-Based?

1. **Decouples request rate from processing capacity**
   - Users get instant response (job ID)
   - Workers process at their own pace
   - No dropped requests during spikes

2. **Enables efficient autoscaling**
   - Scale based on queue depth, not request rate
   - Pre-warm capacity before it's needed
   - Graceful degradation under extreme load

3. **Cost optimization**
   - Workers can be Spot instances (70% savings)
   - No paying for idle Fargate tasks
   - Process in batches for efficiency

## Capacity Planning

### Baseline (Normal Load: 1-2k concurrent)
- 20 EC2 Spot instances (c6g.2xlarge)
- 10 EC2 On-Demand instances
- 0 Fargate tasks
- **Cost: ~$2,500/mo**

### Peak (High Load: 5k concurrent)
- 80 EC2 Spot instances
- 20 EC2 On-Demand instances
- 50 Fargate Spot tasks (overflow)
- **Cost: ~$8,000/mo**

### Surge (Extreme Load: 10k+ concurrent)
- 150 EC2 Spot instances
- 30 EC2 On-Demand instances
- 200 Fargate tasks (burst)
- **Cost: ~$20,000/mo**

## Autoscaling Strategy

### 1. Queue-Based Scaling (Primary)
```yaml
# Scale EC2 based on queue depth
ApproximateNumberOfMessagesVisible > 100 → Add 10 instances
ApproximateNumberOfMessagesVisible > 500 → Add 50 instances
ApproximateNumberOfMessagesVisible > 1000 → Add 100 instances + Enable Fargate burst
```

### 2. Predictive Scaling (Scheduled)
```yaml
# Pre-warm before known peak times
weekday_morning:
  schedule: "cron(0 13 ? * MON-FRI *)"  # 6 AM PT
  min_capacity: 50 instances

weekday_evening:
  schedule: "cron(0 3 ? * * *)"  # 8 PM PT
  min_capacity: 20 instances
```

### 3. Target Tracking (Safety Net)
```yaml
# CPU-based scaling as fallback
CPUUtilization > 70% → Scale out
CPUUtilization < 30% → Scale in (slow)
```

## Instance Type Selection

For agent workloads (CPU + Memory intensive):

| Instance | vCPU | RAM | Spot Price | Tasks/Instance | $/Task-Hour |
|----------|------|-----|------------|----------------|-------------|
| c6g.xlarge | 4 | 8GB | $0.034 | 4 | $0.0085 |
| c6g.2xlarge | 8 | 16GB | $0.068 | 8 | $0.0085 |
| m6g.xlarge | 4 | 16GB | $0.038 | 4-8 | $0.005-0.01 |
| m6g.2xlarge | 8 | 32GB | $0.077 | 8-16 | $0.005-0.01 |
| r6g.xlarge | 4 | 32GB | $0.050 | 8-16 | $0.003-0.006 |

**Recommendation:** Mix of m6g (balanced) and r6g (memory-heavy agents)

## High Availability

### Multi-AZ Deployment
- Spread instances across 3 AZs
- Queue is automatically multi-AZ
- No single point of failure

### Spot Interruption Handling
```
Spot 2-min warning received
         │
         ▼
┌─────────────────────────┐
│ 1. Stop polling queue   │
│ 2. Finish current task  │
│ 3. Push incomplete to   │
│    dead letter queue    │
│ 4. Graceful shutdown    │
└─────────────────────────┘
         │
         ▼
┌─────────────────────────┐
│ ECS/ASG launches        │
│ replacement capacity    │
│ (Fargate if no Spot)    │
└─────────────────────────┘
```

### Circuit Breaker Pattern
```
If error_rate > 10% for 5 minutes:
  → Stop processing new tasks
  → Alert ops team
  → Retry failed tasks with backoff
```

## Cost Optimization

### 1. Spot Instance Diversification
Use multiple instance types to reduce interruption:
```
c6g.xlarge, c6g.2xlarge, c6g.4xlarge
m6g.xlarge, m6g.2xlarge, m6g.4xlarge
r6g.large, r6g.xlarge, r6g.2xlarge
```

### 2. Savings Plans
For baseline capacity (always running):
- Compute Savings Plan: 30-40% off
- 1-year commitment on ~30 instances

### 3. Right-Sizing
Monitor actual usage and adjust:
- Task memory: Set soft limit at 70% of hard limit
- Instance size: Binpack efficiently

## Comparison: ECS vs EKS at Scale

| Factor | ECS | EKS |
|--------|-----|-----|
| Setup complexity | Low | High |
| Scaling speed | Good | Better (Karpenter) |
| Cost | Lower | Higher (+$75/mo/cluster) |
| Flexibility | Limited | High |
| GPU support | Basic | Full |
| Spot handling | Good | Excellent |

**Recommendation:**
- < 5k concurrent → ECS (simpler)
- > 5k concurrent → Consider EKS with Karpenter

## Implementation Priority

1. **Phase 1: Queue Architecture**
   - Add SQS queue for agent runs
   - Modify API to return job IDs
   - Add worker service to poll queue

2. **Phase 2: Hybrid Compute**
   - EC2 Spot fleet for baseline
   - Fargate for burst capacity
   - Queue-based autoscaling

3. **Phase 3: Optimization**
   - Predictive scaling
   - Savings plans for baseline
   - Multi-region for global users
