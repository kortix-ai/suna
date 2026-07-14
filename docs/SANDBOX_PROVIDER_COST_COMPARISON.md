# Sandbox provider cost comparison

**Reference date:** 2026-07-14

**Currency:** USD only

**Benchmark:** a workload that costs exactly **$10,000/month on Daytona**

This is a normalized pricing reference. It does not contain Kortix account
usage, invoice totals, sandbox counts, or other customer-specific numbers.

> **Pricing policy decision (2026-07-14):** Platinum managed retail is modeled
> and positioned at exactly **50% of Daytona's equivalent price**. This
> supersedes the earlier one-third-Daytona assumption.

## The short list

| Provider or architecture | Equivalent monthly price or cost | Versus Daytona | Notes |
|---|---:|---:|---|
| **Platinum managed retail** | **$5,000** | **50% cheaper** | Kortix policy: exactly half of Daytona |
| **Custom AWS Fargate ARM64** | **$5,100-$5,900** | **41-49% cheaper** | Containers, not user-controlled microVMs |
| **Custom AWS ECS on Graviton** | **$5,900-$7,600** | **24-41% cheaper** | Containers on EC2; range covers shared platform services |
| **Custom AWS Fargate x86** | **$6,300-$7,100** | **29-37% cheaper** | Containers; 20 GB ephemeral storage included per task |
| **Self-hosted E2B on AWS, ideal elastic fleet** | **$8,200-$9,500** | **5-18% cheaper** | Requires worker autoscaling not supplied by the current reference deployment |
| **Self-hosted E2B on AWS, fixed fleet with 25% headroom** | **$9,400-$10,800** | **8% cheaper to 8% more expensive** | More realistic current reference-deployment shape |
| **Daytona managed cloud** | **$10,000** | Baseline | Published pay-as-you-go rates |
| **E2B managed cloud Pro** | **$10,053** | **1% more expensive** | Published CPU/RAM rates plus the $150 Pro plan |
| **Modal Sandboxes Team** | **$14,380** | **44% more expensive** | Published Sandbox CPU/RAM rates and net Team plan fee |

The managed-provider numbers use public self-serve prices. AWS and Platinum raw
infrastructure numbers are cost estimates built from public infrastructure
rates; they are not managed-provider quotes.

## Benchmark definition

The comparison uses one generic, common sandbox shape:

| Resource | Per sandbox |
|---|---:|
| CPU | 2 vCPU |
| Memory | 4 GiB |
| Disk | 20 GiB |

At Daytona's published rates, this shape costs:

| Component | Calculation | Cost per sandbox-hour |
|---|---:|---:|
| CPU | 2 × $0.0504 | $0.100800 |
| Memory | 4 × $0.0162 | $0.064800 |
| Billable storage | 15 × $0.000108 after 5 GiB free | $0.001620 |
| **Total** | | **$0.167220** |

A $10,000 Daytona month therefore represents approximately **59,801 sandbox-hours**,
or **83.1 average concurrent sandboxes** across a 720-hour month. Every row uses
that same normalized workload.

This benchmark models steady average utilization. Real bills can differ because
of burst concurrency, minimum allocations, plan limits, regional pricing,
promotional credits, negotiated discounts, data transfer, and taxes.

## Published managed-provider calculation

### Daytona: $10,000 baseline

Published prices used:

| Resource | Published price |
|---|---:|
| CPU | $0.0504/vCPU-hour |
| Memory | $0.0162/GiB-hour |
| Storage | $0.000108/GiB-hour after 5 GiB free |

Daytona advertises $200 in free compute. No promotional or one-time credit is
deducted from the recurring benchmark.

Source: [Daytona pricing](https://www.daytona.io/pricing).

### Platinum managed retail: $5,000

Kortix's Platinum pricing policy is exactly 50% cheaper than Daytona:

| Resource | Platinum policy price |
|---|---:|
| CPU | $0.0252/vCPU-hour |
| Memory | $0.0081/GiB-hour |
| Storage | $0.000054/GiB-hour |
| **Normalized monthly price** | **$10,000 × 50% = $5,000.00** |

This is a Kortix retail policy, not a separately published third-party Platinum
managed-cloud rate card.

### E2B managed Pro: $10,053

Published prices used:

| Resource | Published price |
|---|---:|
| CPU | $0.0504/vCPU-hour |
| Memory | $0.0162/GiB-hour |
| Sandbox disk | 20 GiB included on Pro |
| Pro plan | $150/month plus usage |

For 59,801 hours of the benchmark sandbox:

| Component | Monthly cost |
|---|---:|
| CPU and memory | $9,903 |
| Pro plan | $150 |
| **Total** | **$10,053** |

The average 83.1 concurrent sandboxes fit within Pro's published limit of 100,
but bursts above 100 require additional concurrency. E2B publishes that extra
concurrency is purchasable but does not publish its price. The one-time $100
Hobby credit is not applicable to this recurring Pro comparison.

Source: [E2B pricing](https://e2b.dev/pricing).

### Modal Sandboxes Team: $14,380

Published prices used:

| Resource | Published price |
|---|---:|
| Sandbox CPU | $0.00003942/physical-core-second |
| CPU conversion | 1 physical core equals 2 vCPU |
| Sandbox memory | $0.00000667/GiB-second |
| Team plan | $250/month with $100/month credits |
| Volumes | $0.09/GiB-month with 1 TiB/month free |

For 59,801 hours of the benchmark sandbox:

| Component | Monthly cost |
|---|---:|
| One physical CPU core | $8,486 |
| 4 GiB memory | $5,744 |
| Team plan less monthly credit | $150 |
| **Total** | **$14,380** |

The total uses sandbox-local ephemeral storage. Persistent Modal Volume storage
is workload-dependent and is not silently added. If the 83.1 average concurrent
sandboxes each required 20 GiB of retained Volume capacity, the published
Volume rate would add approximately $48/month after the free first TiB.

Sources: [Modal pricing](https://modal.com/pricing) and
[Modal Sandboxes](https://modal.com/docs/guide/sandbox).

## Platinum raw infrastructure COGS and profit

Platinum runs Cloud Hypervisor microVMs on bare-metal KVM hosts. The reference
host has 384 GiB RAM, 48 physical cores, 96 threads, and local NVMe storage.
Platinum's current capacity model uses 5× CPU overcommit, a 1× hard RAM
guarantee, and sparse/reflink storage.

The host offers used by the Platinum deployment are substantially cheaper than
equivalent hyperscaler instances. The source offers were converted once at the
reference-date exchange rate; only USD values are presented here:

| Host | Resources | USD monthly cost |
|---|---|---:|
| EM-I520E-NVMe | 48 cores / 96 threads, 384 GB RAM, 2 × 3.84 TB NVMe | approximately **$651** |
| EM-I620E-NVMe | 64 cores / 128 threads, 576 GB RAM, 2 × 3.84 TB NVMe | approximately **$777** |
| Shared control plane, database, load balancing, object storage and contingency | Cell-wide estimate | approximately **$250-$600** |

At 83.1 concurrent 4-GiB sandboxes, one host would carry only about 16% memory
headroom and no host redundancy. The commercially safer reference is two
sandbox hosts:

| Platinum economics for the $10,000 Daytona benchmark | One I520 host | Two-I520 safer cell |
|---|---:|---:|
| Estimated infrastructure COGS | approximately $901-$1,251 | approximately **$1,552-$1,902** |
| Retail revenue | $5,000 | $5,000 |
| Gross profit | approximately $3,749-$4,099 | approximately **$3,098-$3,448** |
| Infrastructure gross margin | approximately 75-82% | approximately **62-69%** |

One I520 host can fit the normalized 83.1-sandbox average but provides almost no
safe RAM headroom and no host redundancy. Two hosts are therefore the credible
managed-service comparison. Even with that redundancy, the half-Daytona policy
retains a strong infrastructure margin.

At approximately 90% safe RAM utilization, the host economics improve further:

| Cell | Approximate revenue at half-Daytona pricing | Estimated COGS | Infrastructure margin |
|---|---:|---:|---:|
| Two I520 hosts | $10,200-$10,400/month | $1,552-$1,902/month | approximately **81-85%** |
| Two I620 hosts | approximately $15,300-$15,600/month | $1,804-$2,154/month | approximately **85-88%** |

The I620 costs only about 19% more per month while providing 50% more RAM and
33% more physical cores. It is the stronger density choice once demand can fill
the larger cell. These are infrastructure gross margins, not net margins.

COGS excludes engineering salaries, on-call support, taxes, payment processing,
corporate overhead, and customer acquisition. It should not be described as net
profit.

Sources: [Platinum](https://github.com/kortix-ai/platinum),
[Platinum operations](https://github.com/kortix-ai/platinum/blob/main/OPS.md),
and [Scaleway Elastic Metal pricing](https://www.scaleway.com/en/pricing/?tags=available,compute,elastic-metal).

## Self-hosted E2B on AWS

The E2B AWS reference deployment uses Nomad/Consul control servers, API and
ClickHouse nodes, a template builder, `m8i.4xlarge` nested-virtualization sandbox
workers, gp3 worker disks, an ALB, NAT Gateway, S3, ECR, Secrets Manager, and an
external PostgreSQL database.

Published AWS prices used for the normalized model:

| Resource | Published USD price |
|---|---:|
| `m8i.4xlarge`, 16 vCPU / 64 GiB | $0.84672/hour |
| `m8i.2xlarge` | $0.42336/hour |
| `t3.xlarge` | $0.1664/hour |
| `t3.medium` | $0.0416/hour |
| gp3 | $0.08/GB-month |
| S3 Standard | $0.023/GB-month for the first 50 TB |
| NAT Gateway | $0.045/hour plus $0.045/GB processed |
| Application Load Balancer | $0.0225/hour plus $0.008/LCU-hour |

One `m8i.4xlarge` fits eight benchmark sandboxes. The 83.1-sandbox average needs
10.4 workers at perfect packing or approximately 13 workers with 25% headroom.

| Scenario | Estimated monthly AWS cost |
|---|---:|
| Ideal demand-driven worker autoscaling | **$8,200-$9,500** |
| Fixed 13-worker fleet with 25% headroom | **$9,400-$10,800** |

The current AWS reference fixes the worker Auto Scaling Group minimum and
maximum to the configured cluster size. Achieving the elastic number requires
additional autoscaling, placement, draining, and interruption engineering.
Spot and committed-use discounts are excluded so this remains a public
On-Demand comparison.

Sources: [E2B self-host guide](https://github.com/e2b-dev/infra/blob/main/self-host.md),
[E2B AWS infrastructure](https://github.com/e2b-dev/infra/tree/main/iac/provider-aws),
and [AWS EC2 On-Demand pricing](https://aws.amazon.com/ec2/pricing/on-demand/).

## Custom AWS container sandbox alternatives

These options are cheaper partly because they do not reproduce the E2B or
Platinum microVM contract. Fargate does not expose the nested virtualization,
host root access, huge pages, NBD, and Firecracker lifecycle control needed to
run the E2B worker layer.

### Fargate x86: $6,300-$7,100

Published `us-west-2` rates:

| Resource | Published price |
|---|---:|
| CPU | $0.04048/vCPU-hour |
| Memory | $0.004445/GiB-hour |
| Ephemeral storage | First 20 GB per task included |

The normalized compute cost is approximately $5,905/month. Adding ALB, NAT,
logs, database, registry, and ordinary platform overhead produces the stated
**$6,300-$7,100/month** range.

### Fargate ARM64: $5,100-$5,900

Published rates are $0.03238/vCPU-hour and $0.00356/GiB-hour. Normalized compute
is approximately $4,724/month; shared services produce the stated
**$5,100-$5,900/month** range. This requires ARM64-compatible images and runtime
binaries.

### ECS on Graviton EC2: $5,900-$7,600

Representative published On-Demand hosts:

| Instance | Resources | Published price |
|---|---:|---:|
| `c7g.4xlarge` | 16 vCPU / 32 GiB | $0.58/hour |
| `m7g.4xlarge` | 16 vCPU / 64 GiB | $0.6528/hour |

Approximately 13 nodes provide 25% headroom for the normalized workload. Raw
workers cost roughly $5,429-$6,110/month. Storage, load balancing, NAT, logs,
database, and registry produce the stated **$5,900-$7,600/month** range. ECS has
no separate control-plane fee; choosing standard EKS adds $72/month before any
optional management charges.

Sources: [AWS Fargate pricing](https://aws.amazon.com/fargate/pricing/),
[Amazon ECS pricing](https://aws.amazon.com/ecs/pricing/),
[Amazon EKS pricing](https://aws.amazon.com/eks/pricing/), and
[Amazon EC2 On-Demand pricing](https://aws.amazon.com/ec2/pricing/on-demand/).

## Capability warning

| Capability | Managed Daytona/E2B/Platinum | Custom ECS/EKS containers |
|---|---|---|
| Separate guest kernel | Yes | No on ordinary EC2-backed containers |
| Provider-managed snapshots and resume | Yes | Must be built |
| Privileged workloads inside an isolation boundary | MicroVM-dependent | Restricted, especially on Fargate |
| Persistence after stop | Provider abstraction | EFS/EBS/S3 design required |
| Provider implementation and on-call burden | Purchased service | Owned by Kortix |

The container options are useful cost references, but they are not drop-in
replacements for an agent sandbox microVM platform.

## Bottom line

For every **$10,000 of Daytona spend** under this normalized sandbox mix:

1. Platinum retail policy charges exactly **$5,000**.
2. Custom AWS containers cost approximately **$5,100-$7,600**, with weaker or
   separately engineered sandbox semantics.
3. Self-hosted E2B on AWS costs approximately **$8,200-$10,800**, depending on
   whether Kortix builds real worker autoscaling or carries a fixed fleet.
4. Managed E2B Pro costs approximately **$10,053** before privately priced burst
   concurrency.
5. Modal Sandboxes Team costs approximately **$14,380** before workload-specific
   persistent storage.

Platinum's half-Daytona retail policy leaves substantial room for redundancy and
operations. A dedicated two-I520 cell still produces approximately 62-69%
infrastructure gross margin on the normalized workload, rising above 80% when a
cell is densely utilized. Fleet-wide amortization and measured physical resource
density remain essential before treating infrastructure margin as net profit.
