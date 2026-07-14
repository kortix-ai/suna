# Sandbox provider cost comparison

**Reference date:** 2026-07-14

**Workload window:** the preceding 30 days (720 hours)

**Currency:** USD unless explicitly marked EUR

This document compares the managed sandbox providers and self-hosted runtime
options available to Kortix. It uses one measured Daytona billing period as the
common workload, rather than comparing headline rates against hypothetical
machines.

The comparison covers:

- Daytona managed cloud
- E2B managed cloud
- Modal Sandboxes
- Platinum sold as a Kortix-managed provider
- Platinum's underlying self-hosted infrastructure cost and gross profit
- E2B self-hosted on AWS
- A purpose-built container sandbox platform on AWS ECS/Fargate or ECS/EKS on EC2

## Executive summary

| Option | Estimated monthly price or cost | What the number represents |
|---|---:|---|
| **Platinum managed retail policy** | **$5,881** | Kortix policy target: exactly one-third of Daytona for the same metered workload; not a third-party published rate card |
| **Platinum raw COGS, two sandbox hosts** | **$3,842** | Estimated infrastructure COGS with 35% aggregate RAM headroom; excludes engineering labor |
| **Platinum raw COGS, three sandbox hosts** | **$5,319** | N+1-oriented infrastructure COGS; excludes engineering labor |
| **Custom AWS Fargate, ARM64** | **$9,500-$11,500** | Container sandbox implementation, not E2B/Platinum microVM semantics |
| **Custom AWS Fargate, x86** | **$10,500-$13,000** | Container sandbox implementation, not E2B/Platinum microVM semantics |
| **Custom ECS/EKS on Graviton EC2** | **$11,000-$14,500** | Container sandbox implementation with a managed cluster scheduler |
| **Self-hosted E2B, ideal elastic AWS fleet** | **$14,500-$16,000** | Mathematical lower bound with effective worker autoscaling |
| **E2B managed cloud** | **$16,266 plus extra concurrency if required** | Published Pro plan and CPU/RAM usage; assumes included ephemeral sandbox disk is sufficient |
| **Daytona managed cloud** | **$17,644 actual** | The measured invoice for this workload |
| **Self-hosted E2B, fixed 25-worker AWS fleet** | **$18,000-$20,000** | Realistic unmodified AWS reference deployment |
| **Self-hosted E2B, fixed 30-worker AWS fleet** | **$21,000-$23,000** | More conservative capacity and bin-packing headroom |
| **Modal Sandboxes** | **$23,331 compute; up to ~$25,010 with equivalent retained volume storage** | Published Sandbox CPU/RAM rates, Team plan net credit, and optional volume mapping |

The central conclusion is that the scheduler name is not the primary cost
driver. Isolation model, host type, memory guarantees, storage semantics,
autoscaling, and the amount of platform engineering being purchased are what
change the economics.

Platinum is the lowest-price microVM option under the Kortix pricing policy in this
document. Its margin is healthy with a two-host cell but thin if every cell must
carry a third full sandbox host for N+1 capacity at this workload. Custom AWS
containers can also be inexpensive, but they are a different product and
security boundary. Self-hosted E2B on AWS On-Demand is not clearly cheaper than
the existing Daytona invoice without commitments, Spot capacity, and additional
autoscaling work.

## Measured reference workload

The source billing period contained:

| Metric | 30-day consumption | Average over 720 hours |
|---|---:|---:|
| Sandboxes created | 16,738 | 558/day |
| CPU | 188,589.8 vCPU-hours | 261.93 vCPU |
| Memory | 408,090.3 GiB-hours | 566.79 GiB |
| Disk | 14,169,675.6 GiB-hours | 19,680.11 GiB |
| GPU | 0 | 0 |
| Daytona invoice | $17,644.07 | $24.51 per elapsed hour |

The separately observed `124 vCPU / 264 GiB` live reading is only an
instantaneous sample. It is below the 30-day average and is not a safe fleet
sizing input.

The measured average cost per created sandbox was approximately $1.05. That
figure is useful for financial reporting, but not for capacity planning because
sandbox lifetimes and requested sizes vary.

## Published managed-provider prices

The managed-provider comparison below starts with the providers' public rate
cards, not inferred machine prices or privately negotiated enterprise quotes.
Platinum is the one explicit exception: its row is a proposed Kortix retail
policy derived mechanically from Daytona's published rates.

| Provider | Public plan price and credits | Published usage prices used here | Treatment in the monthly comparison |
|---|---|---|---|
| Daytona | Pay as you go; pricing page advertises $200 in free compute | $0.0504/vCPU-hour; $0.0162/GiB-hour RAM; $0.000108/GiB-hour storage after 5 GiB free | The supplied $17,644.07 invoice is authoritative; no speculative recurring credit is deducted |
| E2B | Pro: $150/month plus usage; Hobby includes a one-time $100 usage credit | $0.0504/vCPU-hour; $0.0162/GiB-hour RAM; 20 GiB sandbox storage included on Pro | Pro fee plus CPU/RAM usage; one-time Hobby credit is not deducted |
| Modal | Team: $250/month plus compute; $100/month free credits | Sandbox CPU: $0.00003942/physical-core-second; RAM: $0.00000667/GiB-second; Volumes: $0.09/GiB-month with 1 TiB/month free | Published Team fee and recurring credit are included; retained Volume storage is shown separately |
| Platinum | No independent public managed-cloud rate card | Kortix policy: each Daytona resource rate divided by three | Exact supplied Daytona invoice divided by three is authoritative |

Public pricing is self-serve list pricing as observed on the reference date.
Taxes, negotiated discounts, enterprise support, excess-concurrency contracts,
and one-time promotional credits are excluded unless explicitly shown.

### Daytona

Daytona's published rates at the reference date were:

| Resource | Published price |
|---|---:|
| vCPU | $0.0504/vCPU-hour |
| Memory | $0.0162/GiB-hour |
| Storage | $0.000108/GiB-hour after the published free allowance |

Applied to the measured usage:

| Component | Calculation | Cost |
|---|---:|---:|
| CPU | 188,589.8 × $0.0504 | $9,504.93 |
| Memory | 408,090.3 × $0.0162 | $6,611.06 |
| Disk | 14,169,675.6 × $0.000108 | $1,530.32 |
| Calculated total | | $17,646.31 |
| Actual invoice | | **$17,644.07** |

The $2.24 difference is consistent with free allowances and billing rounding.
This validates that the supplied resource-hour units can be used directly in
the comparison.

Source: [Daytona pricing](https://www.daytona.io/pricing).

### Platinum managed pricing policy

Platinum's managed retail policy is:

> Use the same metered workload basis as Daytona, priced at exactly one-third
> of the equivalent Daytona charge.

This gives the following Kortix policy rates derived from Daytona's public rate
card:

| Resource | Platinum policy rate | Relationship to Daytona |
|---|---:|---:|
| vCPU | **$0.0168/vCPU-hour** | $0.0504 ÷ 3 |
| Memory | **$0.0054/GiB-hour** | $0.0162 ÷ 3 |
| Storage | **$0.000036/GiB-hour** | $0.000108 ÷ 3 |

For the measured workload:

| Component | Cost |
|---|---:|
| CPU | $3,168.31 |
| Memory | $2,203.69 |
| Disk | $510.11 |
| Total derived from published component rates | $5,882.10 |
| Policy total using the exact Daytona invoice divided by three | **$5,881.36** |

The exact invoice-derived figure is the authoritative comparison total. The
component total differs by $0.74 because it starts from Daytona's unadjusted
published-rate calculation rather than its final invoice allowances.

This is a Kortix pricing policy, not a third-party Platinum SaaS rate card. The
underlying open-source Platinum project describes itself as a self-hosted
microVM cloud rather than a managed SaaS plan. Kortix can nevertheless operate
it as a managed provider and sell the resulting service under this policy.

### E2B managed cloud

E2B's published managed rates were:

| Resource | Published price |
|---|---:|
| CPU | $0.000014/vCPU-second = $0.0504/vCPU-hour |
| Memory | $0.0000045/GiB-second = $0.0162/GiB-hour |
| Sandbox storage | 10 GiB included on Hobby; 20 GiB included on Pro |
| Pro plan | $150/month plus usage |
| Pro concurrency | 100 running sandboxes; additional concurrency can be purchased |

Applied to the workload:

| Component | Cost |
|---|---:|
| CPU | $9,504.93 |
| Memory | $6,611.06 |
| Pro plan | $150.00 |
| Published usage plus plan | **$16,265.99** |

This figure assumes E2B's included 20 GiB sandbox filesystem satisfies the
workload. The Daytona disk-hour total cannot be translated directly because the
providers expose and meter storage differently. The measured average CPU load
also implies more than 100 concurrent two-vCPU sandboxes if the workload were
uniform, so additional E2B concurrency or an enterprise agreement may be
required. E2B does not publish that incremental concurrency price on the public
calculator; it must not be silently treated as zero.

Source: [E2B pricing](https://e2b.dev/pricing).

### Modal Sandboxes

Modal publishes separate, higher rates for Sandboxes and Notebooks than for its
standard function containers:

| Resource | Published Sandbox price |
|---|---:|
| CPU | $0.00003942/physical-core-second |
| CPU equivalence | One physical core is listed as two vCPUs equivalent |
| Memory | $0.00000667/GiB-second |
| Volumes | $0.09/GiB-month, including 1 TiB/month free |
| Team plan | $250/month with $100/month free compute credits |

For an apples-to-apples vCPU conversion, 188,589.8 vCPU-hours becomes 94,294.9
Modal physical-core-hours:

| Component | Calculation | Cost |
|---|---:|---:|
| CPU | 94,294.9 × $0.141912/core-hour | $13,381.58 |
| Memory | 408,090.3 × $0.024012/GiB-hour | $9,799.06 |
| Sandbox compute | | **$23,180.64** |
| Team plan less included $100 credit | $250 - $100 | $150.00 |
| Compute plus net plan | | **$23,330.64** |

Modal sandbox ephemeral filesystem usage is not published as the same GB-hour
meter used by Daytona. If all 19.68 TiB instead had to be retained in Modal
Volumes for the entire month, the volume estimate would add approximately
$1,679 after the first free TiB, producing approximately **$25,010/month**.
That is deliberately shown as an upper mapping rather than mixed into the
compute-only number.

Source: [Modal pricing](https://modal.com/pricing) and [Modal Sandboxes](https://modal.com/docs/guide/sandbox).

## Platinum raw infrastructure cost and gross profit

### Runtime characteristics

Platinum runs one Cloud Hypervisor microVM per sandbox on bare-metal KVM hosts.
The internal operator model currently specifies:

- CPU ticket inventory at 5× physical-core overcommit, protected by CPU-weight
  fairness and a host CPU pressure refusal threshold.
- RAM sold at a 1× hard guarantee. KSM and `MAP_PRIVATE` sharing reduce physical
  use in practice, but that saving is not treated as a contractual capacity
  guarantee.
- Disk tracked at 1× logical allocation, while sparse files and reflinks provide
  an observed effective physical ratio of roughly 2-10×.
- The large-host reference profile has 384 GiB RAM, 48 physical cores / 96
  threads, and 2×3.84 TB NVMe.

At 566.79 GiB average reserved RAM, two 384 GiB hosts provide 768 GiB total,
which is approximately 35% above the measured average. CPU is not the binding
resource under Platinum's workload model. Two hosts do not provide full N+1
capacity: after one host fails, 384 GiB is below the measured 566.79 GiB
average. A three-host cell is therefore included as the stronger reliability
case.

### Public infrastructure inputs

The cost model uses the Scaleway deployment topology documented by Platinum and
the public Scaleway product catalog:

| Resource | Quantity | Public unit rate |
|---|---:|---:|
| EM-I520E-NVMe sandbox host | 2 or 3 | €1.562/hour |
| PRO2-S control-plane node | 2 | €0.22338/hour |
| LB-S | 1 | €0.023/hour |
| DB-DEV-S PostgreSQL nodes | 2 | €0.0136/hour each |
| DB-DEV-S Multi-AZ management | 1 | €0.0075/hour |
| Object Storage Standard Multi-AZ | conservative 19.68 TiB | €0.000022/GiB-hour |
| EUR/USD conversion | | 1 EUR = 1.1424 USD |
| Miscellaneous infrastructure contingency | | 15% |

The object-storage line conservatively maps every average logical disk GiB into
Multi-AZ object storage. Platinum's sparse/reflink/CAS behavior should make real
stored bytes smaller, but that saving is not booked into the headline margin.
The 15% contingency covers monitoring, backups, control-plane disks, DNS,
requests, and normal small infrastructure omissions. It does not include
engineering salaries, support, taxes, payment fees, or corporate overhead.

### COGS and margin

| Platinum cell | Estimated monthly COGS | Retail revenue | Gross profit | Infrastructure gross margin |
|---|---:|---:|---:|---:|
| Two sandbox hosts | **$3,841.73** | $5,881.36 | **$2,039.63** | **34.7%** |
| Three sandbox hosts | **$5,319.24** | $5,881.36 | **$562.12** | **9.6%** |

Interpretation:

- The two-host cell is the economically attractive baseline and has aggregate
  capacity headroom, but cannot sustain the full average load after losing one
  sandbox host.
- The three-host cell carries much stronger failure headroom but nearly consumes
  the margin at the one-third-Daytona retail policy.
- Actual COGS can improve through reserved/monthly bare-metal pricing, higher KSM
  density, lower physical CAS storage, larger cells that amortize the control
  plane, or a tiered reliability policy.
- The price should not be advertised internally as a 67% gross margin merely
  because it is one-third of Daytona. Daytona's retail price is not Platinum's
  cost basis.

Internal implementation references: [Platinum repository](https://github.com/kortix-ai/platinum),
[`OPS.md`](https://github.com/kortix-ai/platinum/blob/main/OPS.md), and
[`docs/host-disk-layout.md`](https://github.com/kortix-ai/platinum/blob/main/docs/host-disk-layout.md).
Public infrastructure source: [Scaleway public product catalog API](https://api.scaleway.com/product-catalog/v2alpha1/public-catalog/products).

## Self-hosted E2B on AWS

### What the reference infrastructure deploys

The E2B AWS reference architecture at commit
[`5b465bc`](https://github.com/e2b-dev/infra/tree/5b465bc3e72aaca4a8c9dd80fada0c3854cd4431)
deploys:

- 3× `t3.medium` Nomad/Consul control servers
- 1× `t3.xlarge` API/control-plane worker
- 1× `t3.xlarge` ClickHouse node
- 1× `m8i.2xlarge` template-build worker
- N× `m8i.4xlarge` sandbox workers with nested virtualization
- 500 GB gp3 root storage on every sandbox worker
- ALB, NAT Gateway, S3, ECR, Secrets Manager, and an external PostgreSQL database

E2B's architecture describes AWS support as beta. More importantly, the current
AWS sandbox-worker Auto Scaling Group sets `min_size` and `max_size` to the same
configured cluster size. The generic architecture describes sandbox nodes as
autoscaled, but the AWS reference does not currently provide demand-driven
sandbox-worker scaling. The elastic estimate below therefore requires
additional engineering.

Sources: [E2B self-host guide](https://github.com/e2b-dev/infra/blob/5b465bc3e72aaca4a8c9dd80fada0c3854cd4431/self-host.md),
[AWS defaults](https://github.com/e2b-dev/infra/blob/5b465bc3e72aaca4a8c9dd80fada0c3854cd4431/iac/provider-aws/variables.tf),
and [AWS worker ASG](https://github.com/e2b-dev/infra/blob/5b465bc3e72aaca4a8c9dd80fada0c3854cd4431/iac/provider-aws/modules/nodepool-client/main.tf).

### AWS price inputs

Rates were queried from the AWS Price List API for `us-west-2`:

| Resource | Price |
|---|---:|
| `m8i.4xlarge`, 16 vCPU / 64 GiB | $0.84672/hour On-Demand |
| `m8i.4xlarge` recent Spot observations | $0.3405-$0.4697/hour; $0.4054 average |
| `m8i.2xlarge` | $0.42336/hour |
| `t3.xlarge` | $0.1664/hour |
| `t3.medium` | $0.0416/hour |
| gp3 | $0.08/GB-month |
| S3 Standard, first 50 TB | $0.023/GB-month |
| NAT Gateway | $0.045/hour + $0.045/GB processed |
| Application Load Balancer | $0.0225/hour + $0.008/LCU-hour |

### Capacity calculation

CPU is the binding resource for the measured workload:

- Perfect packing: 261.93 average vCPU ÷ 16 = 16.37 worker nodes.
- With 25% headroom: 20.46 average worker nodes.
- Many six-vCPU sandboxes fragment a 16-vCPU host into two sandboxes, leaving
  four vCPUs unused and increasing the required worker count.

| Scenario | Estimated monthly AWS cost |
|---|---:|
| Ideal autoscaling, no headroom | $11,800-$13,000 |
| Ideal autoscaling with 25% headroom | **$14,500-$16,000** |
| Fixed 25-worker fleet | **$18,000-$20,000** |
| Fixed 30-worker fleet | **$21,000-$23,000** |
| Ideal 25%-headroom fleet at the observed all-Spot rate | $8,500-$10,000 |

All-Spot is not recommended without sandbox draining, interruption handling,
checkpointing, and placement exclusion. A realistic optimized design would keep
a committed On-Demand base and use Spot only for recoverable burst capacity.

### Storage warning

Daytona's 19.68 TiB average is logical billed storage. E2B uses lazy template
loading, copy-on-write root filesystems, sparse dirty blocks, local caches, and
S3 snapshot artifacts. It is therefore incorrect to multiply every Daytona
disk-hour directly by gp3 pricing.

For bounds:

- 19.68 TiB entirely in S3 Standard is approximately $453/month.
- 19.68 TiB entirely provisioned as gp3 is approximately $1,574/month.
- A fixed 25-worker E2B fleet already contains 12.5 TB of gp3 worker disks at
  approximately $1,000/month.

Physical dirty bytes, retained snapshots, cache hit rate, and egress must be
measured during a pilot before replacing the bounded storage estimates.

## Custom AWS container sandbox platform

This option means building a Kortix-specific sandbox provider on ECS or EKS. It
does not mean placing the existing E2B orchestrator inside Kubernetes.

E2B needs nested virtualization, host root access, huge pages, NBD, cgroups,
and Firecracker lifecycle control. Fargate does not expose those facilities.
Running E2B in privileged pods on nested-virtualization EC2 workers would retain
the expensive `m8i` worker layer and add Kubernetes complexity; it would not
produce the container estimates below.

### ECS Fargate x86

Published `us-west-2` rates:

| Resource | Price |
|---|---:|
| vCPU | $0.04048/vCPU-hour |
| Memory | $0.004445/GiB-hour |
| Ephemeral storage above 20 GB/task | $0.000111/GB-hour |

Applied to the workload:

| Component | Cost |
|---|---:|
| CPU | $7,634.12 |
| Memory | $1,813.96 |
| Compute subtotal | **$9,448.08** |
| Maximum direct mapping of all Daytona disk-hours | $1,572.83 |
| ALB, NAT, logs, database, registry and normal overhead | approximately $700-$2,000+ |
| Expected total | **$10,500-$13,000** |

Fargate includes 20 GB of ephemeral storage per task, so the maximum disk line
is intentionally conservative. The actual value depends on the number of task
hours and which state must persist outside a running task.

### ECS Fargate ARM64

Published ARM rates were $0.03238/vCPU-hour and $0.00356/GiB-hour. The measured
CPU and memory would cost approximately $7,559 before storage and shared
services, producing an expected **$9,500-$11,500/month** total.

This requires ARM64-compatible base images and agent/runtime binaries. It is not
a drop-in assumption for existing x86 templates.

### ECS or EKS on Graviton EC2

Representative On-Demand `us-west-2` hosts:

| Instance | Resources | Price |
|---|---:|---:|
| `c7g.4xlarge` | 16 vCPU / 32 GiB | $0.58/hour |
| `m7g.4xlarge` | 16 vCPU / 64 GiB | $0.6528/hour |

With 25% headroom, the workload needs approximately 22.1 `c7g.4xlarge` nodes or
20.5 `m7g.4xlarge` nodes. Raw worker compute is approximately $9,246-$9,618 per
month. After storage, cluster services, load balancing, NAT, logs and database,
the expected total is **$11,000-$14,000/month**.

ECS has no separate cluster control-plane fee. Standard EKS adds $0.10/hour,
about $72 per 30-day month. EKS Auto Mode adds per-instance management charges;
Karpenter with ordinary EC2 nodes is the lower-cost EKS design.

Sources: [AWS Fargate pricing](https://aws.amazon.com/fargate/pricing/),
[Amazon ECS pricing](https://aws.amazon.com/ecs/pricing/),
[Amazon EKS pricing](https://aws.amazon.com/eks/pricing/), and
[EC2 On-Demand pricing](https://aws.amazon.com/ec2/pricing/on-demand/).

### What is lost relative to microVM providers

| Capability | ECS/EKS containers | E2B / Platinum microVMs |
|---|---|---|
| Kernel isolation | Shared host kernel, except opaque Fargate implementation | Separate guest kernel per sandbox |
| Arbitrary privileged workloads | Restricted; unavailable on Fargate | Supported inside the VM boundary subject to policy |
| E2B-compatible memory snapshots | No | E2B yes; Platinum supports Cloud Hypervisor snapshots |
| Near-instant snapshot resume | Requires custom implementation | Native design goal |
| Filesystem persistence after task stop | External EFS/EBS/S3 design required | Provider snapshot/persistence model |
| Provider implementation effort | High | Already implemented |
| AWS unit economics | Lowest with Graviton/Fargate | Higher nested-virtualization host cost |

Fargate internally uses strong AWS-managed isolation, but AWS does not expose
the Firecracker control surface required to reproduce E2B semantics. Ordinary
EC2-backed ECS/EKS containers share the worker kernel and are not an equivalent
boundary for arbitrary adversarial code.

## Full 4,000-vCPU quota reference

The supplied Daytona account ceiling is not current usage. Supporting it
continuously on self-hosted E2B would require:

- 250 `m8i.4xlarge` workers at perfect packing.
- Approximately 313 workers with 25% headroom.
- Approximately $205,000/month at On-Demand rates including the modeled fixed
  E2B infrastructure, worker disks, and 40 TB object storage.
- Approximately $105,500/month at the observed all-Spot worker rate, before
  designing safe interruption handling.

Provisioning against the quota ceiling would be severe overcapacity relative to
the measured 261.93 average vCPU. The right design target is p95/p99 concurrent
reserved vCPU and RAM, plus a defined failure and burst policy.

## Decision framework

### Choose Daytona when

- Operational simplicity and the proven current integration matter most.
- Paying the managed premium is preferable to owning capacity and reliability.
- The existing workload and bill are acceptable.

### Choose managed E2B when

- E2B SDK and snapshot semantics are preferred.
- The 20 GiB included filesystem fits.
- Required concurrency and enterprise pricing are confirmed contractually.

### Choose Modal when

- Modal's ecosystem, serverless burst model, or GPU services are specifically
  valuable.
- Its higher Sandbox CPU/RAM price is justified by those platform capabilities.
- Workloads naturally terminate within Modal's sandbox lifecycle model.

### Choose Platinum managed when

- Kortix wants the lowest managed microVM price under its stated retail policy
  and controls the fleet.
- The one-third-Daytona pricing policy is strategic.
- Capacity can be pooled across enough customers/cells to amortize N+1 hosts and
  control-plane overhead.
- Kortix is prepared to own the reliability and support burden.

### Choose self-hosted E2B when

- Owning the E2B stack and data plane is mandatory.
- The team is prepared to engineer AWS worker autoscaling and interruptions.
- Commitments or Spot can materially reduce the expensive `m8i` worker layer.

### Choose custom ECS/EKS containers when

- The workloads can accept container rather than microVM semantics.
- Lowest AWS infrastructure cost matters more than provider parity.
- Kortix is willing to build persistence, lifecycle, image, networking,
  metering, security and recovery systems itself.

## Recommended next measurements

Before making a provider migration decision, collect the following for at least
30 days at five-minute resolution:

1. p50, p95, p99 and maximum concurrent reserved vCPU and RAM.
2. Sandbox-size distribution, especially the percentage of six-vCPU sandboxes.
3. Actual dirty filesystem bytes versus logical disk allocation.
4. Paused snapshot bytes, retention age and object-storage request volume.
5. Network ingress, internet egress, and NAT-processed GB.
6. CPU utilization rather than only reserved CPU.
7. Platinum KSM shared-memory ratio and physical resident memory under load.
8. Host-loss capacity requirement: degraded service, N+1, or full no-impact N+1.
9. Creation-rate bursts and acceptable cold-start latency.
10. Engineering and on-call cost allocated to each self-hosted platform.

The last item matters: the infrastructure gross margins above deliberately
exclude labor. A self-hosted platform can have a low cloud bill while still
being more expensive in total cost of ownership than a managed provider.

## Calculation rules and limitations

- A 30-day month is treated as exactly 720 hours.
- Rates are the published or API-returned rates observed on 2026-07-14.
- Taxes, negotiated enterprise discounts, committed-spend credits and support
  contracts are excluded unless explicitly stated.
- Daytona uses the actual supplied invoice as its authoritative total.
- Platinum retail is a pricing policy fixed at the actual Daytona total divided
  by three.
- Platinum COGS is a capacity model based on public Scaleway rates and internal
  runtime requirements; it is not an imported production invoice.
- E2B additional concurrency is unpriced because no public incremental rate was
  available.
- Modal storage is shown separately because Daytona disk-hours do not map
  directly to Modal Volumes.
- AWS bandwidth can materially change every AWS estimate and was not supplied.
- No estimate promises feature, security, or lifecycle equivalence between
  containers and microVMs.
