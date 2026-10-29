---
title: "Getting started with open-source Kortix: from install to a first session"
description: "Install the Kortix CLI, scaffold a project, and ship your first open-source agent session in three commands, then review its change request."
date: "2026-09-25"
canonical: "https://kortix.com/blog/getting-started-with-kortix"
author: "team"
tags: ["Product"]
updated: "2026-10-21"
slug: "/getting-started-with-kortix"
---
Four commands get you from an empty directory to a shipped project: install the CLI, sign in, scaffold, and push. Kortix is open source. What `kortix init` leaves behind is a git repository you own, and the company inside it is yours. Run it on hardware you control, or let Kortix host it, and either way you finish with a change request to review.

## What lands in your project

`kortix init` writes the platform onto your disk: a `kortix.yaml` manifest, starter agents, and the runtime configuration that reads them ([Kortix on GitHub](https://github.com/kortix-ai/suna)). Kortix is the open-source AI Operating System. The directory it creates holds all of it: agents, the skills they draw on, your company's memory, and the connector setup, each one a file you can read in an editor ([Kortix docs](https://kortix.com/docs)). Change a line, and the company changes by that one diff. Revert the line, and the change is gone.

Each file has a job. An agent is an OpenCode agent with scoped reach into tools, written per role or task. A skill records how your company handles one piece of work, so you write it once and any session can load it. Memory is the living company brain, kept in plain files today. Watch a session run and diff what a skill or an agent proposes before it lands ([Kortix about](https://kortix.com/about)).

Each session runs on its own sandbox, on a branch named for that session ([Kortix docs](https://kortix.com/docs)). Inside it the agent installs packages, runs commands, breaks what it likes. The branch is what survives the session. Thousands of sessions can work at once from one configuration. The about page counts the platform in six verbs: build, host, manage and monitor ship today, while train and eval are the layers still being built ([Kortix about](https://kortix.com/about)).

## Install the CLI and scaffold

The installer fetches the release build for macOS and Linux; on Windows, run it inside WSL ([Kortix CLI docs](https://kortix.com/docs/cli)). Then `kortix login`, `kortix init` and `kortix ship` take over.

```bash
curl -fsSL https://kortix.com/install | bash
kortix login
kortix init my-agent
cd my-agent
kortix ship
```

`kortix init` creates a project directory with a general-purpose starter and a `kortix.yaml` manifest that declares its `kortix_version`. `kortix ship` lints that manifest, commits your local changes and pushes the branch. It prompts you for whatever secret or connection is missing. On a project you have not linked yet, that first push is what creates the cloud project ([Kortix CLI docs](https://kortix.com/docs/cli)). Prefer to skip the terminal? Sign up at [Kortix](https://kortix.com), create a project, and start a session with nothing installed ([Kortix on GitHub](https://github.com/kortix-ai/suna)).

## Start a session with a prompt

Give a session a job with `--prompt`, then read the change requests it has opened:

```bash
kortix sessions new --prompt "Summarize this week's commits and open a change request"
kortix cr ls
```

The first command boots a sandbox and runs an agent on your prompt. The second lists the change requests sessions have opened ([Kortix on GitHub](https://github.com/kortix-ai/suna)). Work happens three ways: on demand, when the agent stops to ask you something, or from a schedule or signed webhook. Start a session in a browser, a Slack thread, a terminal or the API. It hands back finished work when it ends.

## Review the change request

The agent opens the change request itself, once the session has commits on its branch; if it has not opened one, ask it to or run `kortix cr open`. You read the diff, then merge it or send it back ([Kortix docs](https://kortix.com/docs)). Nothing merges itself. Session work reaches main through a change request a person approves, unless an admin granted the merge capability.

Approval gates are yours to set, and they stay off until you do. Every action is recorded; reading, exporting and streaming the audit log depend on the plan ([Kortix on GitHub](https://github.com/kortix-ai/suna)). From the CLI, `kortix cr diff <cr>` prints the unified patch. `kortix cr merge <cr>` merges the change into the default branch ([Kortix CLI docs](https://kortix.com/docs/cli)).

## Self-host it or use managed cloud

You can run Kortix on infrastructure you control, or on Kortix Cloud. Self-hosting is free, and it fits a notebook, a small server, space inside your VPC, or hardware in your own building ([Kortix on GitHub](https://github.com/kortix-ai/suna)). `kortix self-host start` brings up an instance on that host. The instance needs a Platinum API key (`PLATINUM_API_KEY`) and a model provider key; without the Platinum key, sessions do not start. Sessions run on Platinum sandboxes, not on the instance host, and need a public domain there, or a Cloudflare tunnel while you evaluate, before they can run. `kortix hosts use selfhost` points the CLI at it, and `kortix hosts use cloud` switches back. Images come from Docker Hub, so the stack still needs a network connection.

Kortix Cloud is billed in credits. Free is $0 with 500 credits a month, every feature and 1 project, on your own provider keys or a ChatGPT subscription. The Kortix-managed models come with the Credits plan only. Paid credits start from $50 a month for 5,000 credits, at 100 credits per dollar. Members cost nothing and there is no limit on how many you add; the account draws on one shared pool, and a month's unused credits roll into the next ([Kortix pricing](https://kortix.com/pricing)). Either way, the commands are the same, so switching hosts does not change how you work.

## Models, tools, and the license

Choose the model per message, per session, or per agent. Bring an API key from any provider you like, or reuse your ChatGPT subscription. OpenCode runs underneath, tuned by configuration that lives in the repo, and its permissions reach down to a single shell command. That harness is open source too, so the runtime is not what locks you in. It also connects 3,000+ apps with a click, and takes MCP, OpenAPI, GraphQL or a raw HTTP endpoint. Connector credentials are brokered server-side and never enter the machine. Each tool call can be allowed, set to ask first, or blocked ([Kortix](https://kortix.com)). The source is yours to read and change, and self-hosting costs nothing ([LICENSE](https://github.com/kortix-ai/suna/blob/main/LICENSE)).

Next reads: [What Kortix actually is](/blog/open-source-ai-management-system), [Introducing Kortix](/blog/introducing-kortix), and [Kortix vs Claude Cowork](/blog/kortix-vs-claude-cowork). Start with [Kortix](https://kortix.com): self-host for nothing, or open an account on 500 credits a month at $0.
