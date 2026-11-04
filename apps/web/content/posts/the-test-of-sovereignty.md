---
title: 'The test of sovereignty: can you swap the model without losing what you built?'
description: 'The most important question for any company adopting AI: can you switch out the model without losing the institutional expertise you have built? A sovereignty checklist for evaluating your AI platform.'
date: '2026-08-02'
author: marko
tags:
  - Architecture
  - Enterprise
  - Open Source
cover: /banner.png
canonical: https://kortix.com/blog/the-test-of-sovereignty
readingTime: 7
lead: 'There is one question that matters more than any other when evaluating an AI platform: **can you switch out the model without losing what you built?** If your state lives in a context window, you lose it when the model changes. If your workflows are embedded in a proprietary vendor’s toolchain, you do not own them. If your company’s knowledge is training data for a model you do not control, you have not built a moat. You have donated your IP.'
---

## The sovereignty checklist

Here are the five criteria I use to evaluate whether an AI platform respects your sovereignty:

- **Model independence** — can you swap the underlying LLM without rewriting your skills, workflows, and memory?
- **Data portability** — can you export everything your system has learned in a standard format?
- **Self-hostability** — can you run the entire stack on your own infrastructure?
- **Open source** — can you audit, modify, and fork the platform itself?
- **Stateless vs. stateful** — does the platform treat your knowledge as persistent state you own, or ephemeral context you rent?

Most AI platforms fail at least four of these. That is not an accident. It is a business model.

## Why most platforms fail this test

The dominant AI platform model today is the walled garden. You bring your data, your prompts, your workflows into a proprietary system. The platform learns from your usage. The platform improves its models. Your company gets faster answers — but the platform captures the compound learning.

When Writer.com cloned Kortix’s open-source code, they copied our token capital — the skills, the agent architecture, the prompts we had published. What they could not copy was the fact that our code is open. Anyone can audit it. Anyone can fork it. Anyone can self-host it. The barrier to entry is not the code. It is the learning loop. And the learning loop is ours because the platform is ours.

> A closed platform is a rental agreement on your own intelligence. The rent goes up every year. The eviction terms are written by the landlord.

## Renting a moat vs. building one

There is a seductive pitch: "Use our platform, and you will be so deeply integrated that switching becomes impossible." That is not a moat. That is golden handcuffs. A real moat is something you build that makes you better over time, not something that makes you stuck.

The difference is clear when you look at what happens if the model provider changes their pricing, their safety policy, or their availability. If you are locked into one provider’s embeddings, one provider’s tool-use format, one provider’s context window — you do not have options. You have a dependency.

## Model independence is the foundation

Model independence is not just about avoiding vendor lock-in. It is about being able to choose the right model for each task. A 7B parameter model running locally might be better for a latency-sensitive internal tool than GPT-5. A fine-tuned open model might outperform a frontier model on your specific domain. A model that costs 10x less might be 95% as good for most tasks.

If your platform is tied to one provider, you cannot make these tradeoffs. You are paying the frontier premium for every task, including the ones that do not need it.

## Open source is the only verifiable path

I have come to believe that open source is not optional for enterprise AI. Not because of ideology. Because of verifiability.

With a closed platform, you cannot verify what happens to your data. You cannot verify how the model is evaluated. You cannot verify what the vendor learns from your usage. You have to trust. And trust is not a security strategy.

With open source, you can verify everything. You can audit the code. You can inspect the data flows. You can run the system on your own infrastructure. You can fork it and extend it in directions the original authors never imagined.

> The test of sovereignty is simple: can you swap the model without losing what you built? If the answer is yes, you own your AI future. If the answer is no, you are renting it.

## Where Kortix stands

Kortix passes every item on the sovereignty checklist. Model-agnostic gateway — swap any LLM without rewriting your skills. Everything is files in a git repo — your token capital is versioned, portable, forkable. Fully self-hostable. Open source under a permissive license.

We built it this way because we believe the company that owns its learning loop wins. Not the company that rents the best API.

```cta
title: Run the test on your AI platform
body: Kortix passes the test of sovereignty. Free to start, free to self-host, free to own your AI future.
```
