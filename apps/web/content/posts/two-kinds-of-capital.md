---
title: 'Your company needs two kinds of capital: human and token'
description: 'Satya Nadella’s frontier-ecosystem framework reveals the most important strategic idea in AI: every company must build human capital and token capital, and they compound together.'
date: '2026-08-02'
author: marko
tags:
  - Vision
  - Strategy
  - Enterprise
cover: /banner.png
canonical: https://kortix.com/blog/two-kinds-of-capital
readingTime: 8
lead: 'Satya Nadella published something recently that I think is the most important strategic idea in AI right now. He calls it the **frontier-ecosystem** framework. The core insight: every company needs two kinds of capital — **human capital** and **token capital** — and they compound together. If you are building an AI strategy without this framework, you are flying blind.'
---

## Human capital is not going away

A common fear I hear from founders: "AI will make our people obsolete." I think the opposite is true. Human capital — the knowledge, judgment, relationships, and pattern recognition of your people — becomes \*more\* valuable as token capital grows, not less.

Here is why. Humans set goals. Humans connect dots across domains. Humans build trust with customers and partners. Humans recognize when the model is confidently wrong. Without human direction, compute runs in circles. It optimizes the wrong thing, or it optimizes the right thing into the ground.

I saw this firsthand when Writer.com cloned Kortix’s open-source code and raised $200M. They took the token capital we publicly shared. What they could not clone was the human capital: the years of judgment about what makes an AI agent actually useful in production, the relationships with our early users, the accumulated pattern recognition of what breaks and why.

> Human capital does not depreciate when token capital appreciates. It compounds. The people who know the domain, the customers, and the failure modes become the most leveraged asset in the company.

## Token capital is the new balance sheet item

Token capital is the AI capability your firm builds and owns. Not the models you rent — the stuff you build. Skills. Workflows. Persistent memory. Private evaluation datasets. Reinforcement learning from your own human feedback.

Most companies are burning token capital without realizing it. Every prompt you type into a closed chat interface is a donation. Your institutional knowledge goes into a context window, gets processed, and disappears. The model learns nothing about your domain. You get an answer, but you do not build capability.

Token capital is not the API key. It is the system you build \*around\* the API key that captures signal, evaluates outputs, and improves over time.

## The learning loop is the moat

The compound interest happens in the loop between people and AI systems. Every completed task, every rejected proposal, every human override is a training signal. If you capture it and feed it back, your system gets smarter. If you do not, you are starting from zero every time.

This is not abstract. It is a concrete architectural decision. Does your platform capture signal and feed it back? Or does it treat every interaction as stateless?

- **Private evals** — your own definition of what "good" looks like. This is the new IP of the firm.
- **Private RL environments** — the ability to practice, fail, and improve in a safe loop before touching production.
- **Persistent memory** — the system that remembers what worked last time, for this user, in this context.

A company that builds these three things owns its trajectory. A company that relies on the provider’s eval set, the provider’s RLHF, and a fresh context window every time is renting intelligence, not building it.

## Offload the task, not the learning

Nadella put it simply: "You can offload a task but never offload your learning." This is the line every company needs to draw. Delegate execution to AI. Keep the learning in-house.

When you offload a task, you get efficiency. When you offload learning, you get dependency. The platform learns; you do not. The vendor improves; you stagnate. Over time, your cost goes down but your capability ceiling hardens.

> The test: if you stopped paying the vendor tomorrow, what would you keep? If the answer is "nothing," you have offloaded learning, not just tasks.

## Where Kortix fits

We built Kortix around this idea. Skills are procedural memory — repeatable expertise encoded in code, not context windows. Everything is files in a git repo, so your token capital is versioned, forkable, and portable. The sandbox is the feedback loop where humans evaluate, correct, and improve. Every interaction builds the system, not just the answer.

Human capital and token capital. Build both. They compound.

```cta
title: Start building your token capital
body: Kortix is the open-source AI OS where your company’s knowledge compounds. Free to start, free to self-host, free to own your learning loop.
```
