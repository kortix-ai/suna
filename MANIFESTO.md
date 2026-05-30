# Kortix

A company is going to be a git repository.

Not as a metaphor. Literally — something you can clone. Inside it: the company's agents, the skills it has built up, the way it actually does its work, every fact it has ever learned, and the definition of the machines all of that runs on. Versioned. Diffable. Owned outright. Running on its own around the clock, opening pull requests against itself, getting better at being your company while everyone's asleep.

That's half the bet. The other half is that an AI-native company needs a single place to be run from. Call it the WordPress of AGI, call it a command center — one core platform where all the context lives, where the agents live, the skills, the triggers, the connectors, the memory, the whole continuous build-out of the company, in one spot, so a person can actually operate the thing instead of duct-taping forty tools together and praying.

OpenAI, Anthropic, and a pile of others are going to build a version of this. Of course they are. The difference is what you get and what you keep. Here you run the best models, whichever ones those are this month, not whatever one vendor happens to sell. It's open. You can run it on your own infrastructure. You own all the data, you own the configuration, you own the stack down to the metal if you want it. Everyone else is building a place to rent your company back to you. We're building the one you own.

Everything else here is just what falls out of taking both halves seriously.

---

## Why now, and why this

The models got good. That part is over. You can hand one a hard problem and it will reason its way through better than most people you've worked with. What it can't do is remember that you exist. Every session it wakes up with no idea who you are, what you're building, what you decided last Tuesday, or where any of your stuff lives. It's brilliant and it has no past. Useless for running anything real.

So people built tools to give it a past. And those tools are demos. One tenant, one machine, no isolation, no version history, no permissions worth the name, no story for security beyond "trust us." You cannot run forty of them at once. You cannot see what changed and roll it back. You cannot put one in front of an enterprise without the security team laughing you out of the building. They're gorgeous on a launch video and they fold the moment a business leans its weight on them.

The other option is to crawl back to the model labs, who will happily host the polished version — and keep your data, your configuration, and your model on their side of the wall, where it stays theirs and you rent access to your own operation forever.

A toy or a cage. That's the actual choice on the table today, and it's a stupid one. Kortix is what you build when you refuse both.

---

## One company, one repo

A Kortix **project** is a git repo, and that repo *is* the company. Configuration and accumulated state in the same place, all of it text, all of it under version control, all of it readable by a person and editable by an agent.

The whole thing is defined by two files:

- **`kortix.toml`** — the Kortix layer. The sandbox image, the cron and webhook triggers, the channels, the apps, the connectors, which secrets are required, where your agent config lives.
- **OpenCode config** — the runtime your agents think in. Agents, skills, commands, tools, plugins, models, providers.

Everything past that is files in the repo. You can `grep` your entire company. You can read any agent's instructions in plain markdown. You can open a memory file and see exactly what it believes about you. Nothing is hidden because there is nowhere to hide it.

Drop into any directory, run `kortix init`, and it's a Kortix. Run `kortix ship` and it's live — it checks that the thing compiles, asks you for whatever secrets it's missing, pushes it up, and from then on it runs. The repo behaves the same on your laptop as it does in the cloud, because it's the same repo doing the same thing. Local development and the live system stopped being different categories.

---

## How a session actually works

Start a session and a sandbox boots from one generic snapshot already running our daemon — **kortix-sandbox-agent-server**. The daemon clones the repo, pulls latest, cuts a fresh branch for this session, reads `kortix.toml` and your OpenCode config into a live runtime, and hands you a machine that's ready. The agent does its work completely walled off from everything else. When it wants to keep something, it commits and opens a change request back toward `main`, and a human decides whether that lands.

The daemon is one executable wrapped around the OpenCode server, and its job is to make sure the project simply runs. A client grabs a session, talks to the daemon, and gets the full API — prompting, streaming, files, a terminal — like it's all sitting on the desk in front of them.

Because a session is its own sandbox on its own branch, you can run fifty of them and they don't touch each other. Fifty coding agents. Fifty agents doing outreach. They can't corrupt a shared anything, and when two of them change the same file, that's a merge, which git has known how to handle for twenty years. The only thing genuinely shared is the world outside — the third-party accounts and the state that lives there. Inside our walls the loop is closed.

A sync engine mirrors sessions and messages into a database so the interface is instant, but the truth of any session always lives in the sandbox that ran it.

Run all of this on our cloud, on bare metal, on-prem, in a microVM. The environment is just more config — describe the box you want, with the libraries you need already on it, and the persistent files load into it.

---

## The pieces you work with

Every one of these is a real resource: spelled out in the repo, managed in an interface that doesn't make you feel stupid, and locked down by actual permissions.

- **Agents** — markdown personas with a prompt and a tightly scoped reach into tools and resources. Installable in one click. Able to rewrite themselves.
- **Skills** — the part that compounds. Markdown plus scripts that encode how the company gets specific work done. They live in the repo and ride into every session.
- **Connectors** — wire up everything once: thousands of apps in a click, plus MCP, OpenAPI, GraphQL, raw HTTP. The sandbox sees all of it through a single proxy with one scoped token instead of a drawer full of keys.
- **Secrets** — encrypted, scoped per person and per group, pushed into the sandbox without ever showing their face, enforceable down at the network. Keys, OAuth, model credentials, one governed place.
- **Channels** — Slack, Teams, Telegram, WhatsApp, SMS, email. One click stands up a bot that starts sessions from wherever your people already are.
- **Triggers** — cron and webhook. Fire a session every morning, or boot one the instant something happens.
- **Sessions** — owned by whoever or whatever started them. You see yours; change the filter to see more. A real API and SDK underneath.
- **Memory** — files for now, and a system that learns later: chew through every session and every connected source and keep a living picture of the company that sharpens by the day.
- **Apps** — declarative, durable deployments. Define a service in config, get a real one you can reach, listed right under the project.

---

## What you actually get out of it

The company is versioned. Every change to an agent, a skill, a memory, an automation is a commit you can read, diff, revert, and prove. Nothing vanishes and nothing happens in the dark.

You connect a source once and the agent gets it through a single key, scoped to whoever started the box, with policies deciding what runs on its own and what waits for a human to say yes.

You can run thousands of agents on the same configuration at the same time, each one boxed off, each one feeding work back through change requests. This is the part nobody else has, and it's the only way an AI workforce is ever more than a slideshow.

The thing runs without you. The main branch is always up. Triggers go off in the night. And any agent, on your laptop or in the cloud, can edit its own configuration and propose the change — so the system files patches against itself, all of it tracked, and the company gets better at being a company over time instead of staying frozen on the day you set it up.

It's built to survive a security review, not slip past one. MicroVM isolation. Egress and credentials controlled at the network. A real account/user/group model where every agent, skill, file, secret, trigger, channel, and connector answers to who is allowed to touch it. Hard gates that make an agent stop and wait for a person before it does something that matters.

And it's yours all the way down. Any model. Your own keys, or the ChatGPT, Claude, or Cursor subscription you already pay for. Our cloud, your servers, or fully on-prem. Everything is files, ready to walk out the door the day you want them to. The labs are paid to lock you in. We only make money if you'd stay anyway.

---

## It has to feel easy

Anyone in the company should be able to open it and use it the first day, from the web, their phone, or a Slack thread, the same way they'd use any chat app. That's not a nice-to-have, it's the point. Most people will never see a `kortix.toml` and shouldn't have to.

Under that surface is as much depth as you can stand. The interface and the code are the same system from two angles, mapping cleanly both ways, so you can change something by clicking or by editing a file and it's the identical change either way. Simple enough that it disappears. Open enough that there's no floor.

---

## Who it's for

**Developers** get a managed cloud for OpenCode, Claude, and Codex agents. One `kortix.toml`, one config, one repo for the state that sticks, and you're running background coding agents. Every PR gets a preview you can actually click through. Bring the subscription you've already got. Have your local agent spin up cloud sessions and go wide. `kortix init`, `kortix ship`, that's the loop.

**Companies** get a workforce they can actually manage. People talk to it through the web, Slack, or Teams. It picks up the business as it goes — its skills, its context, the specific way the work gets done — and it does so on infrastructure where the data, the config, and the model belong to the company instead of a vendor.

**Agencies and consultancies** get the thing to bet on when they bring AI into their clients. One horizontal platform sold through verticalized partners with their own front ends and their own starter templates. They handle distribution and clients, we hand them the technology, the training, and the playbook. A franchise for the part of the economy that's about to get rebuilt.

---

## How this becomes a business

By being the best version of it, and by running on it in public. We build our own companies on Kortix and let people watch: agents reviewing pull requests, preview environments per change, a Slack message turning into a shipped PR, outreach that runs itself, SEO that just happens. The platform is the proof of the platform.

The money is clean. Open source and self-hostable underneath. A cloud where we charge for seats and compute. Single-tenant deployments for the customers who have to run it themselves, anywhere they want to put it. A marketplace of agents, skills, and whole importable projects. And **Platinum.dev** — the compute floor under all of it: CPU and GPU sandboxes, inference, training, built first because we needed millions of cheap, fast, microVM-isolated machines for ourselves, and then opened up to everyone else who needs the same thing on-prem or in a private cloud, for a fraction of what they're paying now.

---

## The end of it

One repo that is a whole company. Thousands of agents on the same config at once, each isolated, each pushing work back into a main branch that never stops running and keeps improving itself. The equivalent of CI/CD, but for the work of an organization instead of just its code. Plain enough that anyone can run it, open enough that anyone can tear it apart and rebuild it, locked down enough that a serious company can stake itself on it.

We're building the thing that takes a company from human to AGI, and lets it keep every byte of itself on the way there.
