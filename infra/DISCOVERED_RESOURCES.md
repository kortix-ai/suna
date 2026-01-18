# Discovered AWS Infrastructure

**Discovery Date:** 2026-01-18  
**Region:** us-west-2  
**AWS Account:** 935064898258

---

## Lightsail Instances

| Name | State | IP | Bundle | Blueprint | AZ | RAM | vCPUs | Disk |
|------|-------|-----|--------|-----------|-----|-----|-------|------|
| suna-dev | running | 35.87.190.182 | large_3_0 | ubuntu_24_04 | us-west-2a | 8 GB | 2 | 160 GB |
| suna-staging | running | 54.184.54.33 | large_3_0 | ubuntu_24_04 | us-west-2a | 8 GB | 2 | 160 GB |
| suna-prod | running | 54.148.221.72 | 8xlarge_3_0 | ubuntu_24_04 | us-west-2a | 128 GB | 32 | 1280 GB |

### Lightsail Static IPs

| Name | IP | Attached To |
|------|-----|-------------|
| StaticIp-1 | 54.184.54.33 | suna-staging |
| StaticIp-2 | 54.148.221.72 | suna-prod |

> **Note:** suna-dev does NOT have a static IP attached

### Lightsail Key Pairs

| Name | Fingerprint |
|------|-------------|
| suna-staging-key | 24:b0:b2:15:1d:85:84:8a:da:ab:10:14:fc:17:4a:fe |
| suna-prod-key | 8b:49:3f:8a:04:32:31:b3:80:e2:64:9e:05:81:2d:85:b3:bf:c3:55 |

---

## VPC & Networking

### VPC

| VPC ID | CIDR | Name | State |
|--------|------|------|-------|
| vpc-059429b1482bcb4a2 | 10.20.0.0/16 | suna-vpc | available |

### Subnets

| Subnet ID | CIDR | AZ | Name | Type |
|-----------|------|-----|------|------|
| subnet-048079b0d4b0cd1df | 10.20.0.0/20 | us-west-2a | suna-public-0 | Public |
| subnet-07eb84400f296dc6c | 10.20.16.0/20 | us-west-2b | suna-public-1 | Public |
| subnet-0dff21dd37bef46e0 | 10.20.32.0/20 | us-west-2c | suna-public-2 | Public |
| subnet-050b82fe4bd582da8 | 10.20.128.0/19 | us-west-2a | suna-private-0 | Private |
| subnet-04d2ad7a0897103d4 | 10.20.160.0/19 | us-west-2b | suna-private-1 | Private |
| subnet-045eb85b5bfc4e0c1 | 10.20.192.0/19 | us-west-2c | suna-private-2 | Private |

### Internet Gateway

| IGW ID | VPC ID | Name |
|--------|--------|------|
| igw-08bb55e0b0f4a400b | vpc-059429b1482bcb4a2 | suna-igw |

### NAT Gateways

| NAT Gateway ID | Subnet ID | Name | Public IP |
|----------------|-----------|------|-----------|
| nat-05dec7ddb520f8ef1 | subnet-048079b0d4b0cd1df | suna-nat-0 | 52.32.109.224 |
| nat-07198ef973a7b458b | subnet-07eb84400f296dc6c | suna-nat-1 | 52.32.114.156 |
| nat-005beb4356de283a4 | subnet-0dff21dd37bef46e0 | suna-nat-2 | 44.231.249.128 |

### Elastic IPs (for NAT)

| Allocation ID | Public IP | Name |
|---------------|-----------|------|
| eipalloc-047838211dab8b0d9 | 52.32.109.224 | suna-nat-eip-0 |
| eipalloc-03eb6fdd9dd26a81e | 52.32.114.156 | suna-nat-eip-1 |
| eipalloc-085d82e613129465d | 44.231.249.128 | suna-nat-eip-2 |

### Route Tables

| Route Table ID | Name |
|----------------|------|
| rtb-0d0588e73ece4fee0 | suna-public-rt |
| rtb-05625663487292be3 | suna-private-rt-0 |
| rtb-0af4fec5ad6f28d50 | suna-private-rt-1 |
| rtb-03d8fdf446c68ecaa | suna-private-rt-2 |

### Security Groups

| Group ID | Name | Description |
|----------|------|-------------|
| sg-05781b733fe85aa05 | suna-alb-sg | ALB SG allowing 80/443 from anywhere |
| sg-01452dafd65486ab5 | suna-ecs-tasks-sg | ECS tasks SG allowing 8000 from ALB |
| sg-04d4716ff11efa835 | suna-redis-sg | ElastiCache Serverless SG - ECS and Lightsail access |

---

## ECS Cluster

### Cluster

| Name | Status | Running Tasks | Container Instances |
|------|--------|---------------|---------------------|
| suna-ecs | ACTIVE | 4 | 3 |

**ARN:** `arn:aws:ecs:us-west-2:935064898258:cluster/suna-ecs`

### Service

| Name | Status | Desired | Running | Task Definition |
|------|--------|---------|---------|-----------------|
| suna-api-svc-6a0ece6 | ACTIVE | 4 | 4 | suna-api:60 |

**ARN:** `arn:aws:ecs:us-west-2:935064898258:service/suna-ecs/suna-api-svc-6a0ece6`

### Task Definition

| Family | Revision | Network Mode |
|--------|----------|--------------|
| suna-api | 60 | awsvpc |

### Capacity Provider

| Name | Status | Target Capacity | Warmup Period |
|------|--------|-----------------|---------------|
| suna-capacity-625da4b | ACTIVE | 100% | 120s |

### Auto Scaling Group

| Name | Min | Max | Desired | Instances |
|------|-----|-----|---------|-----------|
| suna-ecs-asg-092e94f | 2 | 8 | 3 | i-009042a0d83a2a3ee, i-073f0da03ae9b8a9d, i-07dfe32de240a5dcf |

### Launch Templates

| Name | ID | Latest Version |
|------|----|----------------|
| suna-ecs-20260108070707816600000006 | lt-04a29b3839fa8a617 | 1 |
| suna-ecs-20260108053338916200000006 | lt-0649057ce123facb0 | 1 |

---

## Load Balancer

### ALB

| Name | DNS | Type | Scheme | State |
|------|-----|------|--------|-------|
| suna-alb-3975a7d | suna-alb-3975a7d-1271164322.us-west-2.elb.amazonaws.com | application | internet-facing | active |

**ARN:** `arn:aws:elasticloadbalancing:us-west-2:935064898258:loadbalancer/app/suna-alb-3975a7d/7561e782b30fc489`

### Listeners

| Port | Protocol | ARN |
|------|----------|-----|
| 80 | HTTP | arn:aws:elasticloadbalancing:us-west-2:935064898258:listener/app/suna-alb-3975a7d/.../ce7380a862c2a30b |
| 443 | HTTPS | arn:aws:elasticloadbalancing:us-west-2:935064898258:listener/app/suna-alb-3975a7d/.../4d1619e10b357feb |

### Target Group

| Name | Port | Protocol | Health Check |
|------|------|----------|--------------|
| suna-api-tg-2ca3a58 | 8000 | HTTP | /v1/health-docker |

**ARN:** `arn:aws:elasticloadbalancing:us-west-2:935064898258:targetgroup/suna-api-tg-2ca3a58/6128555cf310c98a`

---

## Redis

### Production Decision: Upstash (Cloud)

**DO NOT USE** the discovered ElastiCache Serverless. Use **Upstash** instead for cloud-based Redis.

| Provider | Type | Notes |
|----------|------|-------|
| **Upstash** | Cloud Redis | Preferred - serverless, global, pay-per-request |
| ~~ElastiCache~~ | ~~AWS Managed~~ | ~~Ignore - suna-valkey exists but not to be used~~ |

### Discovered ElastiCache (TO BE REMOVED)

| Name | Status | Engine | Endpoint |
|------|--------|--------|----------|
| suna-valkey | available | valkey | suna-valkey-r1ljes.serverless.usw2.cache.amazonaws.com |

> **Action:** Delete `suna-valkey` ElastiCache Serverless after confirming Upstash is configured.

---

## IAM Resources

### Roles

| Role Name | ARN |
|-----------|-----|
| suna-ecs-instance-role-0c3e46e | arn:aws:iam::935064898258:role/suna-ecs-instance-role-0c3e46e |
| suna-ecs-instance-role-6c4aa15 | arn:aws:iam::935064898258:role/suna-ecs-instance-role-6c4aa15 |
| suna-task-exec-role-07671de | arn:aws:iam::935064898258:role/suna-task-exec-role-07671de |
| suna-task-exec-role-118d470 | arn:aws:iam::935064898258:role/suna-task-exec-role-118d470 |
| suna-task-role-2873804 | arn:aws:iam::935064898258:role/suna-task-role-2873804 |
| suna-task-role-2f6cfc0 | arn:aws:iam::935064898258:role/suna-task-role-2f6cfc0 |

### Instance Profiles

| Name | Role |
|------|------|
| suna-ecs-instance-profile-267ecb1 | suna-ecs-instance-role-0c3e46e |
| suna-ecs-instance-profile-66935ea | suna-ecs-instance-role-6c4aa15 |

---

## Certificates (ACM)

| Domain | ARN | Status |
|--------|-----|--------|
| api.kortix.com | arn:aws:acm:us-west-2:935064898258:certificate/bc99f310-e64d-44fe-a161-d33bb8abf86d | ISSUED |
| *.kortix.com | arn:aws:acm:us-west-2:935064898258:certificate/d70f1f49-d981-4add-abb6-971bad1f3755 | ISSUED |

---

## Secrets Manager

| Name | ARN |
|------|-----|
| suna-env-35648ec | arn:aws:secretsmanager:us-west-2:935064898258:secret:suna-env-35648ec-j3MF94 |

---

## CloudWatch

### Log Groups

| Name | Retention |
|------|-----------|
| /ecs/suna-api-e74cd53 | 30 days |
| /ecs/suna-api-f4ebf11 | 30 days |

### Alarms

| Name | Metric | State |
|------|--------|-------|
| suna-alb-4xx-033f530 | HTTPCode_Target_4XX_Count | OK |
| suna-alb-5xx-c765e6f | HTTPCode_ELB_5XX_Count | OK |
| suna-alb-latency-5ff803d | TargetResponseTime | OK |
| suna-api-cpu80-c96b32b | CPUUtilization | OK |
| suna-api-mem85-b43c0ff | MemoryUtilization | OK |
| suna-target-5xx-08c0714 | HTTPCode_Target_5XX_Count | OK |
| suna-tg-unhealthy-3405316 | UnhealthyHostCount | INSUFFICIENT_DATA |

---

## SNS Topics

| ARN |
|-----|
| arn:aws:sns:us-west-2:935064898258:suna-alerts-7606606 |
| arn:aws:sns:us-west-2:935064898258:suna-alerts-941293c |

---

## S3 Buckets (ALB Logs)

| Name |
|------|
| suna-alb-logs-1d27256 |
| suna-alb-logs-fc5d290 |

---

## Cloudflare Resources

**Account ID:** 9785405a992435bb0c7bd19f9b6d26d5

### Zones

| Zone | Zone ID | Status |
|------|---------|--------|
| kortix.ai | 78c55de396872e437b5d1641efb00869 | active |
| kortix.cloud | a5c979714e0e76cc2e8c98af3025f2f3 | active |
| kortix.com | af378d3df4e4dd5052a1fcbf263b685d | active |
| suna.so | cb0c8537f735d98fbbed1ae142f94fbe | active |

### Cloudflare Tunnels

| Environment | Tunnel Name | Tunnel ID | Status |
|-------------|-------------|-----------|--------|
| DEV | DEVELOPMENT API Lightsail | 3a533a53-67d0-487c-b716-261c863270ee | healthy |
| STAGING | STAGING API Lightsail | 503813f5-2426-401a-b72f-15bd11d4b4ba | healthy |
| PROD | PRODUCTION API Lightsail | f4125d84-33d5-424d-ae6b-2b84b790392b | healthy |

### Tunnel Ingress Rules

**DEV Tunnel (3a533a53...):**
| Hostname | Service |
|----------|---------|
| dev-api.kortix.com | http://localhost:8000 |
| (catch-all) | http_status:404 |

**STAGING Tunnel (503813f5...):**
| Hostname | Service |
|----------|---------|
| staging-api.suna.so | http://localhost:8000 |
| staging-api.kortix.com | http://localhost:8000 |
| (catch-all) | http_status:404 |

**PROD Tunnel (f4125d84...):**
| Hostname | Service |
|----------|---------|
| api.kortix.com | http://localhost:8000 |
| api-lightsail.kortix.com | http://localhost:8000 |
| (catch-all) | http_status:404 |

### Cloudflare Worker (Production Router)

| Property | Value |
|----------|-------|
| Name | api-kortix-router |
| Custom Domain | api.kortix.com |
| Active Backend | lightsail (configurable) |
| Created | 2026-01-08 |

**Worker Code:**
```javascript
export default {
  async fetch(request, env) {
    const activeBackend = env.ACTIVE_BACKEND || 'lightsail';
    
    const backends = {
      lightsail: 'https://api-lightsail.kortix.com',
      ecs: 'https://api-ecs.kortix.com'
    };
    
    const url = new URL(request.url);
    const backendUrl = backends[activeBackend];
    
    if (!backendUrl) {
      return new Response('Invalid backend configuration', { status: 500 });
    }
    
    const targetUrl = new URL(url.pathname + url.search, backendUrl);
    
    const modifiedRequest = new Request(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'follow'
    });
    
    const response = await fetch(modifiedRequest);
    const newResponse = new Response(response.body, response);
    newResponse.headers.set('X-Backend', activeBackend);
    
    return newResponse;
  }
};
```

**Worker Environment Variables:**
| Name | Value |
|------|-------|
| ACTIVE_BACKEND | lightsail |

### DNS Records (API-related)

**kortix.com:**
| Record | Type | Target | Proxied |
|--------|------|--------|---------|
| api.kortix.com | AAAA | 100:: (Worker) | Yes |
| api-lightsail.kortix.com | CNAME | f4125d84-...cfargotunnel.com | Yes |
| api-ecs.kortix.com | CNAME | suna-alb-3975a7d-...elb.amazonaws.com | No |
| dev-api.kortix.com | CNAME | 3a533a53-...cfargotunnel.com | Yes |
| staging-api.kortix.com | CNAME | 503813f5-...cfargotunnel.com | Yes |

**suna.so:**
| Record | Type | Target | Proxied |
|--------|------|--------|---------|
| api.suna.so | CNAME | 7e745116-...cfargotunnel.com | Yes |
| staging-api.suna.so | CNAME | 503813f5-...cfargotunnel.com | Yes |

> **Note:** api.suna.so points to tunnel 7e745116... which doesn't exist in active tunnels. This may be broken/orphaned.

---

## Summary

### Resource Counts

| Category | Count |
|----------|-------|
| **AWS** | |
| Lightsail Instances | 3 |
| Static IPs | 2 |
| VPCs | 1 |
| Subnets | 6 (3 public, 3 private) |
| NAT Gateways | 3 |
| Security Groups | 3 |
| ECS Clusters | 1 |
| ECS Services | 1 |
| ALBs | 1 |
| Target Groups | 1 |
| ~~ElastiCache Serverless~~ | ~~1~~ (use Upstash instead) |
| IAM Roles | 6 |
| ACM Certificates | 2 (valid) |
| CloudWatch Alarms | 15 |
| Secrets | 1 |
| S3 Buckets | 2 |
| **Cloudflare** | |
| Zones | 4 |
| Tunnels | 3 |
| Workers | 1 |
| DNS Records (API) | 7 |

### Architecture Diagram

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
                    │   (Tunnel f4125d84)                (Direct to ALB)       │
                    └─────────┬─────────────────────────────────┬──────────────┘
                              │                                 │
                              ▼                                 ▼
┌─────────────────────────────────────────┐    ┌───────────────────────────────────┐
│         LIGHTSAIL (Prod)                │    │           ECS (Prod)              │
│   suna-prod: 54.148.221.72              │    │   Cluster: suna-ecs               │
│   128GB RAM, 32 vCPU                    │    │   4 tasks on 3 instances          │
│   Cloudflared → localhost:8000          │    │   ALB → Target Group → Tasks      │
└─────────────────────────────────────────┘    └───────────────────────────────────┘

┌─────────────────────────────────────────┐    ┌───────────────────────────────────┐
│         LIGHTSAIL (Dev)                 │    │         LIGHTSAIL (Staging)       │
│   suna-dev: 35.87.190.182               │    │   suna-staging: 54.184.54.33      │
│   8GB RAM, 2 vCPU                       │    │   8GB RAM, 2 vCPU                 │
│   Tunnel → dev-api.kortix.com           │    │   Tunnel → staging-api.kortix.com │
└─────────────────────────────────────────┘    └───────────────────────────────────┘
```

### Notes

1. **Duplicate Resources:** Some resources have duplicates (e.g., IAM roles, log groups, alarms) - likely from Pulumi updates creating new resources instead of updating existing ones. Terraform should consolidate.

2. **suna-dev Missing Static IP:** The dev instance doesn't have a static IP attached.

3. **Redis:** Use **Upstash** (cloud Redis), NOT the discovered ElastiCache Serverless (suna-valkey).

4. **api.suna.so Broken:** Points to non-existent tunnel 7e745116. Needs fixing.

5. **Worker Routing:** Currently all api.kortix.com traffic goes to Lightsail. ECS is available but not active (`ACTIVE_BACKEND=lightsail`).
