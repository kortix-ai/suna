---
title: "Cloudflare OS is open source. The account is the decision."
description: "Cloudflare OS is open source and every workspace runs as a Worker in a Cloudflare account, so ask whose account your operating layer lives in."
date: "2026-10-21"
slug: "/cloudflare-os-open-source-ownership"
canonical: "https://kortix.com/blog/cloudflare-os-open-source-ownership"
author: "team"
tags: ["Comparisons"]
---
Cloudflare OS is an open-source agent workspace for every person in a company; Kortix is the open-source AI Operating System that a company runs from a git repo it owns. You can fork the Cloudflare core repository, change it, and deploy it. Cloudflare says any organization can connect it to internal systems and make it their own. A company weighing it should ask one more question: whose account the finished system runs in, and how much of the company's own context stays there.

Kortix keeps its agents, skills, memory and connector config as files in that repo. The same stack runs on Kortix Cloud, in your VPC, or on your own on-prem network.

## What Cloudflare released in August

[Cloudflare's launch post](https://blog.cloudflare.com/cloudflare-os) says Cloudflare OS "gives every person an agent and workspace built around their company". Three parts make it up: an agent workspace with an isolated runtime, a security and governance framework for reaching internal data, and a platform for small apps that people build and share. Cloudflare ran an earlier version internally from May. The version it open sourced is the rebuild that came out of that year's lessons.

Two repositories shipped: the core, and an example deployment modeled on Cloudflare's own. The second one is where the company's setup goes. Cloudflare describes that repository as consuming the core without patching it, "providing a place for configuration, custom UI, internal integrations, analytics, and deployment pipelines". It is also where the product lands: "You can deploy it into your own Cloudflare account and use your own Access policies, AI Gateway configuration, data, and integrations." Partners do the delivery. Presidio and Happy Cog will customize Cloudflare OS around how an organization operates and roll it out across a workforce.

On [October 1](https://blog.cloudflare.com/managed-cloudflare-os), Cloudflare opened a waitlist for a fully managed version. "With a few clicks in the Cloudflare dashboard, you'll be able to launch your organization's own agent workspace," that post says. The post adds: "We'll handle the rest." Cloudflare is equally direct about the self-deployed path. It "gives you full control, but it also means someone has to configure the deployment, operate it, and keep it up to date."

## Every app is a Worker, every workspace a Durable Object

The runtime is Cloudflare's, and the launch post is open about it. "Every app is a Worker," and "Server code runs in a Dynamic Worker with global outbound networking disabled." [The repository](https://github.com/cloudflare/cloudflare-os) is more specific again: "Every workspace is its own Durable Object, every Gadget runs in a Dynamic Worker Facet," with a SQLite database per app. Model calls travel the same road. "Cloudflare OS can be used with any model. Every inference call runs through Cloudflare AI Gateway."

That stack buys real protections. Workspaces and apps start with access to nothing. A Gatekeeper, a Worker in front of each external service, "holds the credential, enforces policy, records what was read". The record then follows the data. If an agent reads a sensitive table and builds a dashboard from it, the Gatekeeper checks whether the person opening the dashboard was allowed to read the table. Permission sits on the operation: an agent can read issues and not source code, and a merge can require approval. For a company whose worst case is one over-broad API key in a chat window, this is serious design.

It also decides where you can take the product. Cloudflare's README points out that `workerd`, the Workers runtime, is open source. Cloudflare OS therefore "can run entirely on top of it on your own servers". The README then adds that the documentation and tooling to make that smooth are still being written. On hardware you control, it is possible in principle and unsupported in practice. The supported path is a Cloudflare account, deployed by you or, in the managed version, theirs under your domain.

## Your company's setup lives in a repo you can clone

A Kortix project is a git repository. `kortix.yaml` at its root is the operating setup itself: which agents exist, what each may reach, which connectors and secrets they get, and what runs on a clock.

```yaml
kortix_version: 2
runtime: opencode
default_agent: kortix

project:
  name: acme

agents:
  kortix:
    connectors: all
    secrets: all
    skills: all

  memory-reflector:
    kortix_cli: [project.cr.open]

triggers:
  - slug: memory-reflector
    type: cron
    agent: memory-reflector
    cron: "0 0 3 * * *"
    prompt: |
      Reflect on the last 24 hours of project activity, update
      memory/, and open one change request.
```

[The Kortix CLI](https://kortix.com/docs/cli) does the rest: `kortix init` turns a directory into that project, `kortix ship` validates `kortix.yaml`, commits the setup and pushes the branch, and `kortix self-host start` moves the setup to another host. Every grant, prompt and remembered fact is a line in a file with an author, a timestamp and a diff. The whole operating layer answers to `grep`, and undo is `git revert`. Model choice works the same way: any model provider with your own keys, or the ChatGPT plan you already pay for.

Cloudflare OS keeps the company's context in a deployment repo wrapped around Cloudflare's platform. Kortix keeps it in the repository the platform reads. A procurement conversation turns on that difference. The Kortix setup can be carried to another host. The Cloudflare deployment was built to run on Cloudflare.

## Side by side

| | Kortix | Cloudflare OS |
| --- | --- | --- |
| Open source | Yes, self-host or managed cloud | Apache-2.0 core and an example deployment |
| Where it runs | Kortix Cloud, your VPC, or your network | Your Cloudflare account, or Cloudflare-managed |
| Company configuration | `kortix.yaml` in the repo you own | A deployment repo around the core |
| Model choice | Any model provider, your own keys | Any model, through Cloudflare AI Gateway |
| Connectors | 3,000+ apps, MCP, OpenAPI, GraphQL, HTTP | Gatekeepers and MCP server portals |
| Who reviews work | A change request; merge is default-deny for agents | Gatekeeper policy per service, approvals on calls |
| An app per person | Per-tool Apps: one URL, numbered releases | Yes, the product is the app per person |

## What Cloudflare OS is better at

One kind of company should pick Cloudflare OS, and the fit is specific. You have already standardized on Cloudflare, you have no platform team of your own, and you would rather buy a security model than run one. Building a small tool for one team, sharing it, and letting the next person change it themselves is a workflow Cloudflare OS has thought about more than anyone.

Kortix comes at that job from the other side. It ships a tool as an [App](https://kortix.com/docs/apps) with one stable URL, numbered releases and an access policy that signs people in before the code runs. What it does not have is an app that lives inside each person's own workspace, edited in place by the person who uses it.

The governance design earns its place too. Every agent and app starts at zero access, and an agent's reach is decided one service at a time. That is closer to how a security reviewer thinks than one project-wide credential. If Cloudflare Access already fronts your internal systems and a vendor will operate the workspace, the managed option is the shortest route to a working company agent.

## What to do next

If you want per-person apps and a vendor-run deployment inside an account you already pay for, Cloudflare OS is a sound choice. Its source is on GitHub to read before you commit.

If what you want is an operating layer the company keeps, with the configuration in your own repo and the choice of where it runs left open, that is the other design. It is the one we build, for a structural reason: the repo comes with you.

Session work reaches `main` through a change request, and merge is default-deny for agents. Thousands of agents run in parallel on one config, each on its own cloud computer. [What Kortix is, layer by layer](/blog/open-source-ai-management-system) is the long read, and [self-hosting it](/blog/self-hosted-claude-cowork) covers the box you can put it on.

Take one job, put the setup in a repo you own, and let the agent open the change request. Free to start, free to self-host. [Try Kortix](https://kortix.com)
