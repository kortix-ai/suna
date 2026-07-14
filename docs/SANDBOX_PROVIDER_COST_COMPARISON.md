# Sandbox provider cost comparison

**Reference date:** 2026-07-14

**Currency:** USD only

**Comparison unit:** hours of the default Kortix sandbox delivered by a
**$1,000 budget**

> **Pricing policy decision:** Platinum managed retail is exactly **50% of
> Daytona's equivalent price**.

This is a normalized pricing reference. It contains no Kortix account usage,
invoice totals, or customer-specific consumption.

## Default Kortix sandbox

Every calculation uses the same sandbox:

| Resource | Default allocation |
|---|---:|
| CPU | 2 vCPU |
| Memory | 4 GiB |
| Disk | 20 GiB |

One **sandbox-hour** means this complete 2-vCPU / 4-GiB / 20-GiB sandbox runs
for one hour. Ten such sandboxes running for 100 hours equal 1,000
sandbox-hours.

## Headline comparison

Managed-plan fees are deducted from the $1,000 budget before purchasing usage.
Self-hosted and custom AWS rows are steady-state equivalents based on a
right-sized production fleet; they do not imply that a fractional cluster can
literally be purchased for $1,000.

| Provider or architecture | Effective all-in cost per sandbox-hour | Default-sandbox hours from $1,000 | Cost of 1,000 sandbox-hours | Notes |
|---|---:|---:|---:|---|
| **Platinum managed retail** | **$0.08361** | **11,960** | **$83.61** | Exactly half of Daytona |
| **Custom AWS Fargate ARM64** | $0.085-$0.099 | 10,136-11,726 | $85-$99 | Steady-state estimate including shared services; container semantics |
| **Custom AWS ECS on Graviton** | $0.099-$0.127 | 7,869-10,136 | $99-$127 | Steady-state estimate; container semantics |
| **Custom AWS Fargate x86** | $0.105-$0.119 | 8,422-9,492 | $105-$119 | Steady-state estimate including shared services; container semantics |
| **Self-hosted E2B on AWS, ideal elastic fleet** | $0.137-$0.159 | 6,295-7,293 | $137-$159 | Requires additional worker-autoscaling engineering |
| **Self-hosted E2B on AWS, fixed fleet** | $0.157-$0.181 | 5,537-6,362 | $157-$181 | Current reference-deployment behavior with capacity headroom |
| **Daytona managed cloud** | **$0.16722** | **5,980** | **$167.22** | Published pay-as-you-go rates |
| **E2B managed Pro, all-in** | $0.16560 usage | **5,133** | **$315.60 for the first 1,000 hours** | $150 plan is deducted from the budget; incremental hours after plan cost $0.16560 |
| **Modal Sandboxes Team, all-in** | $0.23796 usage | **3,572** | **$387.96 for the first 1,000 hours** | $250 plan less $100 monthly credit leaves a net $150 base cost |

The raw ordering should not be read as capability equivalence. ECS and Fargate
containers do not provide the same user-controlled microVM boundary, snapshot
contract, or persistence model as Daytona, E2B, or Platinum.

## Managed-provider calculations

### Daytona: 5,980 hours per $1,000

Published prices:

| Component | Calculation | Cost per sandbox-hour |
|---|---:|---:|
| CPU | 2 × $0.0504 | $0.100800 |
| Memory | 4 × $0.0162 | $0.064800 |
| Billable disk | 15 × $0.000108 after 5 GiB free | $0.001620 |
| **Total** | | **$0.167220** |

Therefore:

- `$1,000 ÷ $0.167220 = 5,980` default-sandbox hours.
- 1,000 default-sandbox hours cost `$167.22`.

Daytona advertises $200 in free compute. No promotional or one-time credit is
deducted from this recurring comparison.

Source: [Daytona pricing](https://www.daytona.io/pricing).

### Platinum managed: 11,960 hours per $1,000

Platinum's managed retail policy is exactly half of Daytona:

| Resource | Platinum policy price |
|---|---:|
| CPU | $0.0252/vCPU-hour |
| Memory | $0.0081/GiB-hour |
| Storage | $0.000054/GiB-hour |
| **Default sandbox** | **$0.083610/hour** |

Therefore:

- `$1,000 ÷ $0.083610 = 11,960` default-sandbox hours.
- 1,000 default-sandbox hours cost `$83.61`.
- The same budget always buys exactly twice as many Platinum hours as Daytona
  for an equivalent resource shape.

This is a Kortix pricing policy, not a third-party Platinum SaaS rate card.

### E2B managed Pro: 5,133 all-in hours per $1,000

Published prices:

| Resource | Published price |
|---|---:|
| CPU | $0.0504/vCPU-hour |
| Memory | $0.0162/GiB-hour |
| Sandbox disk | 20 GiB included on Pro |
| Pro plan | $150/month plus usage |

The default sandbox uses `$0.16560/hour` of CPU and RAM.

| View | Calculation | Result |
|---|---:|---:|
| $1,000 all-in monthly budget | ($1,000 - $150) ÷ $0.16560 | **5,133 hours** |
| $1,000 incremental usage after plan is paid | $1,000 ÷ $0.16560 | 6,039 hours |
| First 1,000 hours including the plan | $150 + (1,000 × $0.16560) | **$315.60** |
| Each later 1,000 hours in the same month | 1,000 × $0.16560 | $165.60 |

Pro includes up to 100 concurrently running sandboxes. Additional concurrency
is purchasable, but E2B does not publish its price. The one-time Hobby credit is
excluded.

Source: [E2B pricing](https://e2b.dev/pricing).

### Modal Sandboxes Team: 3,572 all-in hours per $1,000

Published prices:

| Resource | Published price |
|---|---:|
| Sandbox CPU | $0.00003942/physical-core-second |
| CPU conversion | 1 physical core equals 2 vCPU |
| Sandbox memory | $0.00000667/GiB-second |
| Team plan | $250/month with $100/month credits |
| Volumes | $0.09/GiB-month with 1 TiB/month free |

The default sandbox consumes one Modal physical core plus 4 GiB RAM:

| Component | Cost per sandbox-hour |
|---|---:|
| CPU | $0.141912 |
| Memory | $0.096048 |
| **Usage total** | **$0.237960** |

| View | Calculation | Result |
|---|---:|---:|
| $1,000 all-in monthly budget | ($1,000 - $150 net plan cost) ÷ $0.237960 | **3,572 hours** |
| $1,000 incremental usage after plan is paid | $1,000 ÷ $0.237960 | 4,202 hours |
| First 1,000 hours including net plan cost | $150 + (1,000 × $0.237960) | **$387.96** |
| Each later 1,000 hours in the same month | 1,000 × $0.237960 | $237.96 |

The total uses sandbox-local ephemeral storage. Persistent Volume storage is
workload-dependent and is not silently added.

Sources: [Modal pricing](https://modal.com/pricing) and
[Modal Sandboxes](https://modal.com/docs/guide/sandbox).

## Platinum raw infrastructure economics

Platinum runs one Cloud Hypervisor microVM per sandbox on bare-metal KVM hosts.
The repo's capacity model uses 5× CPU ticket capacity, a 1× hard RAM guarantee,
and sparse/reflink disk behavior. RAM is the binding guaranteed resource.

The source host offers were converted once at the reference-date exchange rate;
only USD values are presented:

| Host | Resources | USD monthly cost |
|---|---|---:|
| EM-I520E-NVMe | 48 cores / 96 threads, 384 GB RAM, 2 × 3.84 TB NVMe | approximately **$651** |
| EM-I620E-NVMe | 64 cores / 128 threads, 576 GB RAM, 2 × 3.84 TB NVMe | approximately **$777** |
| Shared control plane, database, load balancing, object storage and contingency | Cell-wide estimate | approximately **$250-$600** |

Raw capacity-hours assume at most 90% of host RAM is assigned to sandbox
workloads, leaving room for the host OS and platform services:

| Cell | Safe monthly default-sandbox capacity | Estimated monthly COGS | Raw capacity-hours per $1,000 COGS | Raw COGS per sandbox-hour |
|---|---:|---:|---:|---:|
| One I520, no host redundancy | approximately 61,000 hours | $901-$1,251 | 48,800-67,700 | $0.0148-$0.0205 |
| Two I520 hosts | approximately 122,000 hours | $1,552-$1,902 | **64,100-78,600** | **$0.0127-$0.0156** |
| Two I620 hosts | approximately 183,000-187,000 hours | $1,804-$2,154 | **85,000-103,700** | **$0.0097-$0.0118** |

At the managed retail price of `$0.08361/hour`, these dense-cell economics
produce approximately:

- **81-85% infrastructure gross margin** on two I520 hosts.
- **85-88% infrastructure gross margin** on two I620 hosts.

The I620 costs only about 19% more than the I520 while providing 50% more RAM
and 33% more physical cores. It is the stronger density choice when demand can
fill the larger cell.

Raw capacity-hours are not the same as billable usage hours. Empty capacity
still costs money. These margins exclude engineering salaries, on-call support,
taxes, payment processing, corporate overhead, and customer acquisition.

Sources: [Platinum](https://github.com/kortix-ai/platinum),
[Platinum operations](https://github.com/kortix-ai/platinum/blob/main/OPS.md),
[Platinum host disk layout](https://github.com/kortix-ai/platinum/blob/main/docs/host-disk-layout.md),
and [Scaleway Elastic Metal pricing](https://www.scaleway.com/en/pricing/?tags=available,compute,elastic-metal).

## Self-hosted E2B on AWS

The E2B AWS reference deploys Nomad/Consul control servers, API and ClickHouse
nodes, a template builder, nested-virtualization sandbox workers, gp3 worker
disks, ALB, NAT Gateway, S3, ECR, Secrets Manager, and PostgreSQL.

One `m8i.4xlarge` fits eight default Kortix sandboxes. The estimates include the
worker fleet and shared E2B infrastructure:

| Scenario | Effective cost per sandbox-hour | Steady-state hours represented by $1,000 |
|---|---:|---:|
| Ideal demand-driven worker autoscaling | $0.137-$0.159 | **6,295-7,293** |
| Fixed fleet with 25% capacity headroom | $0.157-$0.181 | **5,537-6,362** |

The current AWS reference fixes the sandbox-worker Auto Scaling Group minimum
and maximum to the configured cluster size. Achieving the elastic number needs
additional autoscaling, placement, draining, and interruption engineering.
Spot and committed-use discounts are excluded.

Sources: [E2B self-host guide](https://github.com/e2b-dev/infra/blob/main/self-host.md),
[E2B AWS infrastructure](https://github.com/e2b-dev/infra/tree/main/iac/provider-aws),
and [AWS EC2 On-Demand pricing](https://aws.amazon.com/ec2/pricing/on-demand/).

## Custom AWS container alternatives

These estimates include ordinary shared-service overhead and express the result
as steady-state sandbox-hour equivalents:

| Architecture | Raw compute cost per sandbox-hour | All-in steady-state estimate | Hours represented by $1,000 |
|---|---:|---:|---:|
| Fargate ARM64 | $0.07900 | $0.085-$0.099 | **10,136-11,726** |
| Fargate x86 | $0.09874 | $0.105-$0.119 | **8,422-9,492** |
| ECS on Graviton EC2 | Capacity-based | $0.099-$0.127 | **7,869-10,136** |

Published input rates:

| Resource | Published price |
|---|---:|
| Fargate x86 CPU | $0.04048/vCPU-hour |
| Fargate x86 memory | $0.004445/GiB-hour |
| Fargate ARM64 CPU | $0.03238/vCPU-hour |
| Fargate ARM64 memory | $0.00356/GiB-hour |
| `c7g.4xlarge`, 16 vCPU / 32 GiB | $0.58/hour |
| `m7g.4xlarge`, 16 vCPU / 64 GiB | $0.6528/hour |

Fargate includes the first 20 GB of task ephemeral storage. Shared-service
overhead covers a normal range for load balancing, NAT, logs, database and
registry costs. Actual transfer and observability volume can move the result.

Sources: [AWS Fargate pricing](https://aws.amazon.com/fargate/pricing/),
[Amazon ECS pricing](https://aws.amazon.com/ecs/pricing/),
[Amazon EKS pricing](https://aws.amazon.com/eks/pricing/), and
[Amazon EC2 On-Demand pricing](https://aws.amazon.com/ec2/pricing/on-demand/).

## Capability warning

| Capability | Daytona / E2B / Platinum | Custom ECS/EKS containers |
|---|---|---|
| Separate guest kernel | Yes | No on ordinary EC2-backed containers |
| Provider-managed snapshots and resume | Yes | Must be built |
| Privileged workloads inside an isolation boundary | MicroVM-dependent | Restricted, especially on Fargate |
| Persistence after stop | Provider abstraction | EFS/EBS/S3 design required |
| Provider implementation and on-call burden | Purchased or existing platform | Owned by Kortix |

Fargate does not expose the nested virtualization, host root access, huge pages,
NBD, or Firecracker lifecycle control required to reproduce E2B's worker layer.
The container estimates are cost references, not drop-in replacements.

## Bottom line

For a recurring **$1,000 budget** and the default Kortix sandbox:

1. Platinum managed provides **11,960 sandbox-hours**.
2. Custom AWS containers represent approximately **7,869-11,726 hours**, with
   materially different isolation and persistence semantics.
3. Self-hosted E2B represents approximately **5,537-7,293 hours**, depending on
   whether Kortix builds demand-driven worker autoscaling.
4. Daytona provides **5,980 hours**.
5. E2B Pro provides **5,133 all-in hours** after its $150 plan fee.
6. Modal Team provides **3,572 all-in hours** after its net $150 plan cost.

Platinum's half-Daytona policy is the simplest invariant: every dollar buys
exactly twice the equivalent Daytona sandbox time. Corrected bare-metal host
prices leave strong room for redundancy and operations, provided the fleet is
utilized rather than left idle.
