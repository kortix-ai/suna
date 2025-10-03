# AWS Deployment Guide for Kortix

## Prerequisites
- AWS Account with billing enabled
- AWS CLI installed and configured
- Docker installed locally
- Domain name (optional but recommended)

## Architecture Overview

```
Internet
   │
   ├─→ CloudFront (CDN)
   │      └─→ S3 Bucket (Frontend static files)
   │
   └─→ Route 53 (DNS)
         └─→ Application Load Balancer
               ├─→ ECS Fargate Service (Backend API)
               │      └─→ Tasks (2-10 auto-scaled)
               │
               └─→ ECS Fargate Service (Workers)
                      └─→ Tasks (2-10 auto-scaled)
                      
   ElastiCache Redis ←── (Private VPC connection)
   Supabase (External) ←── (HTTPS)
```

## Step 1: Setup VPC and Networking

```bash
# Create VPC with public and private subnets
aws ec2 create-vpc --cidr-block 10.0.0.0/16 --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=kortix-vpc}]'

# Note the VPC ID from output
export VPC_ID=<your-vpc-id>

# Create public subnets (for ALB) in 2 AZs
aws ec2 create-subnet --vpc-id $VPC_ID --cidr-block 10.0.1.0/24 --availability-zone us-east-1a
aws ec2 create-subnet --vpc-id $VPC_ID --cidr-block 10.0.2.0/24 --availability-zone us-east-1b

# Create private subnets (for ECS tasks) in 2 AZs
aws ec2 create-subnet --vpc-id $VPC_ID --cidr-block 10.0.10.0/24 --availability-zone us-east-1a
aws ec2 create-subnet --vpc-id $VPC_ID --cidr-block 10.0.11.0/24 --availability-zone us-east-1b

# Create Internet Gateway
aws ec2 create-internet-gateway
aws ec2 attach-internet-gateway --vpc-id $VPC_ID --internet-gateway-id <igw-id>

# Create NAT Gateway (for private subnet internet access)
# First allocate Elastic IP
aws ec2 allocate-address --domain vpc
aws ec2 create-nat-gateway --subnet-id <public-subnet-id> --allocation-id <eip-allocation-id>
```

## Step 2: Setup ElastiCache Redis

```bash
# Create Redis subnet group
aws elasticache create-cache-subnet-group \
  --cache-subnet-group-name kortix-redis-subnet \
  --cache-subnet-group-description "Kortix Redis subnet group" \
  --subnet-ids <private-subnet-1-id> <private-subnet-2-id>

# Create security group for Redis
aws ec2 create-security-group \
  --group-name kortix-redis-sg \
  --description "Security group for Kortix Redis" \
  --vpc-id $VPC_ID

# Allow inbound on port 6379 from ECS tasks
aws ec2 authorize-security-group-ingress \
  --group-id <redis-sg-id> \
  --protocol tcp \
  --port 6379 \
  --source-group <ecs-sg-id>

# Create Redis cluster
aws elasticache create-cache-cluster \
  --cache-cluster-id kortix-redis \
  --cache-node-type cache.t3.medium \
  --engine redis \
  --engine-version 7.0 \
  --num-cache-nodes 1 \
  --cache-subnet-group-name kortix-redis-subnet \
  --security-group-ids <redis-sg-id>

# Note the Redis endpoint
```

## Step 3: Setup ECR (Container Registry)

```bash
# Create repositories
aws ecr create-repository --repository-name kortix/backend --region us-east-1
aws ecr create-repository --repository-name kortix/frontend --region us-east-1

# Login to ECR
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <account-id>.dkr.ecr.us-east-1.amazonaws.com

# Build and push backend
cd backend
docker build -t kortix/backend .
docker tag kortix/backend:latest <account-id>.dkr.ecr.us-east-1.amazonaws.com/kortix/backend:latest
docker push <account-id>.dkr.ecr.us-east-1.amazonaws.com/kortix/backend:latest

# Build and push frontend
cd ../frontend
docker build -t kortix/frontend .
docker tag kortix/frontend:latest <account-id>.dkr.ecr.us-east-1.amazonaws.com/kortix/frontend:latest
docker push <account-id>.dkr.ecr.us-east-1.amazonaws.com/kortix/frontend:latest
```

## Step 4: Setup ECS Cluster

```bash
# Create ECS cluster
aws ecs create-cluster --cluster-name kortix-cluster --capacity-providers FARGATE FARGATE_SPOT

# Create CloudWatch log groups
aws logs create-log-group --log-group-name /ecs/kortix-backend
aws logs create-log-group --log-group-name /ecs/kortix-worker
```

## Step 5: Store Environment Variables in Secrets Manager

```bash
# Create secrets for backend
aws secretsmanager create-secret \
  --name kortix/backend/env \
  --description "Kortix backend environment variables" \
  --secret-string file://backend/.env

# Create secrets for frontend
aws secretsmanager create-secret \
  --name kortix/frontend/env \
  --description "Kortix frontend environment variables" \
  --secret-string file://frontend/.env.local
```

## Step 6: Create ECS Task Definitions

Create `backend-task-definition.json`:

```json
{
  "family": "kortix-backend",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "2048",
  "memory": "4096",
  "executionRoleArn": "arn:aws:iam::<account-id>:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::<account-id>:role/ecsTaskRole",
  "containerDefinitions": [
    {
      "name": "backend",
      "image": "<account-id>.dkr.ecr.us-east-1.amazonaws.com/kortix/backend:latest",
      "essential": true,
      "portMappings": [
        {
          "containerPort": 8000,
          "protocol": "tcp"
        }
      ],
      "environment": [
        {
          "name": "REDIS_HOST",
          "value": "<redis-endpoint>"
        },
        {
          "name": "REDIS_PORT",
          "value": "6379"
        },
        {
          "name": "REDIS_SSL",
          "value": "true"
        },
        {
          "name": "ENV_MODE",
          "value": "production"
        }
      ],
      "secrets": [
        {
          "name": "SUPABASE_URL",
          "valueFrom": "arn:aws:secretsmanager:us-east-1:<account-id>:secret:kortix/backend/env:SUPABASE_URL::"
        },
        {
          "name": "SUPABASE_ANON_KEY",
          "valueFrom": "arn:aws:secretsmanager:us-east-1:<account-id>:secret:kortix/backend/env:SUPABASE_ANON_KEY::"
        },
        {
          "name": "SUPABASE_SERVICE_ROLE_KEY",
          "valueFrom": "arn:aws:secretsmanager:us-east-1:<account-id>:secret:kortix/backend/env:SUPABASE_SERVICE_ROLE_KEY::"
        },
        {
          "name": "ANTHROPIC_API_KEY",
          "valueFrom": "arn:aws:secretsmanager:us-east-1:<account-id>:secret:kortix/backend/env:ANTHROPIC_API_KEY::"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/kortix-backend",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "ecs"
        }
      },
      "healthCheck": {
        "command": ["CMD-SHELL", "curl -f http://localhost:8000/api/health || exit 1"],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 60
      }
    }
  ]
}
```

Create `worker-task-definition.json`:

```json
{
  "family": "kortix-worker",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "2048",
  "memory": "4096",
  "executionRoleArn": "arn:aws:iam::<account-id>:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::<account-id>:role/ecsTaskRole",
  "containerDefinitions": [
    {
      "name": "worker",
      "image": "<account-id>.dkr.ecr.us-east-1.amazonaws.com/kortix/backend:latest",
      "essential": true,
      "command": ["uv", "run", "dramatiq", "--skip-logging", "--processes", "4", "--threads", "4", "run_agent_background"],
      "environment": [
        {
          "name": "REDIS_HOST",
          "value": "<redis-endpoint>"
        },
        {
          "name": "REDIS_PORT",
          "value": "6379"
        },
        {
          "name": "REDIS_SSL",
          "value": "true"
        },
        {
          "name": "ENV_MODE",
          "value": "production"
        }
      ],
      "secrets": [
        {
          "name": "SUPABASE_URL",
          "valueFrom": "arn:aws:secretsmanager:us-east-1:<account-id>:secret:kortix/backend/env:SUPABASE_URL::"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/kortix-worker",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
```

Register task definitions:

```bash
aws ecs register-task-definition --cli-input-json file://backend-task-definition.json
aws ecs register-task-definition --cli-input-json file://worker-task-definition.json
```

## Step 7: Create Application Load Balancer

```bash
# Create ALB security group
aws ec2 create-security-group \
  --group-name kortix-alb-sg \
  --description "Security group for Kortix ALB" \
  --vpc-id $VPC_ID

# Allow HTTP/HTTPS from internet
aws ec2 authorize-security-group-ingress --group-id <alb-sg-id> --protocol tcp --port 80 --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id <alb-sg-id> --protocol tcp --port 443 --cidr 0.0.0.0/0

# Create ALB
aws elbv2 create-load-balancer \
  --name kortix-alb \
  --subnets <public-subnet-1-id> <public-subnet-2-id> \
  --security-groups <alb-sg-id> \
  --scheme internet-facing \
  --type application

# Create target group for backend
aws elbv2 create-target-group \
  --name kortix-backend-tg \
  --protocol HTTP \
  --port 8000 \
  --vpc-id $VPC_ID \
  --target-type ip \
  --health-check-path /api/health \
  --health-check-interval-seconds 30 \
  --healthy-threshold-count 2 \
  --unhealthy-threshold-count 3

# Create listener
aws elbv2 create-listener \
  --load-balancer-arn <alb-arn> \
  --protocol HTTP \
  --port 80 \
  --default-actions Type=forward,TargetGroupArn=<target-group-arn>
```

## Step 8: Create ECS Services

```bash
# Create backend service
aws ecs create-service \
  --cluster kortix-cluster \
  --service-name kortix-backend \
  --task-definition kortix-backend \
  --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[<private-subnet-1>,<private-subnet-2>],securityGroups=[<ecs-sg-id>],assignPublicIp=DISABLED}" \
  --load-balancers "targetGroupArn=<target-group-arn>,containerName=backend,containerPort=8000" \
  --health-check-grace-period-seconds 60

# Create worker service
aws ecs create-service \
  --cluster kortix-cluster \
  --service-name kortix-worker \
  --task-definition kortix-worker \
  --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[<private-subnet-1>,<private-subnet-2>],securityGroups=[<ecs-sg-id>],assignPublicIp=DISABLED}"
```

## Step 9: Setup Auto Scaling

```bash
# Register scalable target for backend
aws application-autoscaling register-scalable-target \
  --service-namespace ecs \
  --scalable-dimension ecs:service:DesiredCount \
  --resource-id service/kortix-cluster/kortix-backend \
  --min-capacity 2 \
  --max-capacity 10

# Create scaling policy for backend (CPU-based)
aws application-autoscaling put-scaling-policy \
  --service-namespace ecs \
  --scalable-dimension ecs:service:DesiredCount \
  --resource-id service/kortix-cluster/kortix-backend \
  --policy-name cpu-scaling \
  --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration file://scaling-policy.json

# scaling-policy.json
{
  "TargetValue": 70.0,
  "PredefinedMetricSpecification": {
    "PredefinedMetricType": "ECSServiceAverageCPUUtilization"
  },
  "ScaleInCooldown": 300,
  "ScaleOutCooldown": 60
}

# For workers, scale based on Redis queue depth (custom metric)
# You'll need to push custom CloudWatch metrics from your app
```

## Step 10: Deploy Frontend to S3 + CloudFront

```bash
# Create S3 bucket
aws s3 mb s3://kortix-frontend-production

# Build frontend
cd frontend
npm run build
npm run export  # If using static export

# Sync to S3
aws s3 sync out/ s3://kortix-frontend-production --delete

# Create CloudFront distribution
aws cloudfront create-distribution --distribution-config file://cloudfront-config.json

# cloudfront-config.json
{
  "Comment": "Kortix Frontend",
  "Origins": {
    "Items": [
      {
        "Id": "kortix-s3",
        "DomainName": "kortix-frontend-production.s3.amazonaws.com",
        "S3OriginConfig": {
          "OriginAccessIdentity": ""
        }
      }
    ]
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "kortix-s3",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": {
      "Items": ["GET", "HEAD", "OPTIONS"],
      "CachedMethods": {
        "Items": ["GET", "HEAD"]
      }
    },
    "Compress": true
  },
  "Enabled": true,
  "DefaultRootObject": "index.html"
}
```

## Step 11: Setup CI/CD with GitHub Actions

Create `.github/workflows/deploy-aws.yml`:

```yaml
name: Deploy to AWS

on:
  push:
    branches: [main]

env:
  AWS_REGION: us-east-1
  ECR_REPOSITORY_BACKEND: kortix/backend
  ECR_REPOSITORY_FRONTEND: kortix/frontend
  ECS_SERVICE_BACKEND: kortix-backend
  ECS_SERVICE_WORKER: kortix-worker
  ECS_CLUSTER: kortix-cluster

jobs:
  deploy-backend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v2
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ env.AWS_REGION }}
      
      - name: Login to ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v1
      
      - name: Build and push backend
        env:
          ECR_REGISTRY: ${{ steps.login-ecr.outputs.registry }}
          IMAGE_TAG: ${{ github.sha }}
        run: |
          cd backend
          docker build -t $ECR_REGISTRY/$ECR_REPOSITORY_BACKEND:$IMAGE_TAG .
          docker push $ECR_REGISTRY/$ECR_REPOSITORY_BACKEND:$IMAGE_TAG
          docker tag $ECR_REGISTRY/$ECR_REPOSITORY_BACKEND:$IMAGE_TAG $ECR_REGISTRY/$ECR_REPOSITORY_BACKEND:latest
          docker push $ECR_REGISTRY/$ECR_REPOSITORY_BACKEND:latest
      
      - name: Update ECS services
        run: |
          aws ecs update-service --cluster $ECS_CLUSTER --service $ECS_SERVICE_BACKEND --force-new-deployment
          aws ecs update-service --cluster $ECS_CLUSTER --service $ECS_SERVICE_WORKER --force-new-deployment
  
  deploy-frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'
      
      - name: Install and build
        run: |
          cd frontend
          npm ci
          npm run build
      
      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v2
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ env.AWS_REGION }}
      
      - name: Deploy to S3
        run: |
          aws s3 sync frontend/.next/static s3://kortix-frontend-production/_next/static --delete
          aws s3 sync frontend/public s3://kortix-frontend-production/public --delete
      
      - name: Invalidate CloudFront
        run: |
          aws cloudfront create-invalidation --distribution-id ${{ secrets.CLOUDFRONT_DISTRIBUTION_ID }} --paths "/*"
```

## Monitoring and Logging

### CloudWatch Dashboards

Create a dashboard to monitor:
- ECS CPU/Memory utilization
- ALB request count and latency
- Redis CPU/Memory
- Custom metrics (agent task duration, queue depth)

### Alarms

Set up CloudWatch alarms for:
- High CPU/Memory on ECS tasks
- HTTP 5xx errors from ALB
- Redis connection failures
- Low task count

### Cost Optimization Tips

1. Use Fargate Spot for non-critical workers (70% cost savings)
2. Use S3 Intelligent-Tiering for file storage
3. Enable ALB access logs only when debugging
4. Use Reserved Capacity for ElastiCache in production
5. Set up budget alerts

## Estimated Monthly Costs

| Service | Configuration | Monthly Cost |
|---------|---------------|--------------|
| ECS Fargate (Backend) | 2 tasks, 2vCPU, 4GB, 24/7 | ~$80 |
| ECS Fargate (Workers) | 2 tasks, 2vCPU, 4GB, 24/7 | ~$80 |
| ElastiCache Redis | cache.t3.medium | ~$50 |
| Application Load Balancer | 1 ALB + data transfer | ~$25 |
| CloudFront | 1TB transfer | ~$85 |
| S3 Storage | 100GB | ~$2.30 |
| ECR Storage | 10GB | ~$1 |
| CloudWatch Logs | 50GB | ~$25 |
| Data Transfer | 500GB | ~$45 |
| **Total** | | **~$393/mo** |

With optimizations (Spot, compression, caching):
**~$260-310/mo**


