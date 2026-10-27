---
title: "What ChatGPT Work's control page admits, and what an open-source stack must prove"
description: "Every ChatGPT Work control rests on a sentence OpenAI wrote. All ten are quoted with their URLs, beside what open-source Kortix answers and concedes."
date: "2026-10-21"
canonical: "https://kortix.com/blog/chatgpt-work-enterprise-controls-recheck"
author: "team"
tags: ["Field notes"]
updated: "2026-10-21"
slug: "/chatgpt-work-enterprise-controls-recheck"
---
If someone hands you a ChatGPT Work control list to sign off, ask for the sentence behind each cell and the page it came from. [OpenAI's ChatGPT Work overview](https://learn.chatgpt.com/docs/enterprise/chatgpt-work-overview) documents ten controls for Work, and every one can be tied to a sentence the page writes itself. The record holds all ten, each with its quote and its URL. Kortix is the open-source AI Operating System, and on 2026-10-21 all ten of those sentences were still there.

## Ten controls, each with the sentence behind it

The list below is the whole record. One block per control: the sentence OpenAI writes, the URL that sentence came from, and the equivalent in a stack a team can read. Quotes are copied word for word, the concessions included. A concession is the part a review has to price.

```yaml
checked: 2026-10-21
sources:
  overview: https://learn.chatgpt.com/docs/enterprise/chatgpt-work-overview
  enterprise: https://chatgpt.com/business/enterprise/
  announcement: https://openai.com/index/introducing-chatgpt-enterprise/

rows:
  - control: Cloud execution
    source: overview
    quote: >-
      Cloud execution runs supported steps on OpenAI-managed infrastructure.
    kortix: One isolated sandbox per session, its own machine and branch
    kortix_docs: https://kortix.com/docs/work/sessions

  - control: Outbound destinations
    source: overview
    quote: >-
      Turning it off limits code and shell commands to required destinations on the managed allowlist
    kortix: No outbound allowlist documented; a secret can be egress-enforced
    kortix_docs: https://kortix.com/docs/project/secrets

  - control: Approval before an action
    source: overview
    quote: >-
      Not every app supports the same action controls, and not every action requires an individual human confirmation.
    kortix: Approval gates you set. Off until you set them.
    kortix_docs: https://kortix.com/docs/connect/connectors#policies-and-approvals

  - control: Which policy wins
    source: overview
    quote: >-
      MDM and legacy managed-device requirements rank above Agent Security.
    kortix: Project rules first, then connector rules; first match wins
    kortix_docs: https://kortix.com/docs/project/manifest#policy-and-policies

  - control: Hooks
    source: overview
    quote: >-
      Local computer access with Work Cloud supports admin-defined MCP hooks
    kortix: Every connector call is checked by policy, then recorded
    kortix_docs: https://kortix.com/docs/connect/connectors

  - control: Complete execution history
    source: overview
    quote: >-
      These user-visible records don’t establish Compliance API export or a complete administrator-visible execution history.
    kortix: One row per API request, and an agent row names the person it acted for
    kortix_docs: https://kortix.com/docs/accounts#audit-log

  - control: Compliance record retention
    source: overview
    quote: >-
      Compliance Logs Platform records: Remain available in the platform for 30 days.
    kortix: 0 to 90 days live, 90 to 365 in a locked archive
    kortix_docs: https://kortix.com/docs/accounts#retention-and-export

  - control: Data residency
    source: overview
    quote: >-
      Data residency and inference residency cover only eligible content and supported workloads, regions, and configurations.
    kortix: The self-hosted stack keeps the API, database and files on your server
    kortix_docs: https://kortix.com/docs/host

  - control: Zero data retention on a connected computer
    source: overview
    quote: >-
      Local computer access with Work Cloud does not provide strict zero data retention.
    kortix: Zero data retention at the model provider; a runtime secret is a real value in the session
    kortix_docs: https://kortix.com/docs/project/models

  - control: Local execution boundary
    source: overview
    quote: >-
      A task cannot switch from local execution to the cloud during a turn.
    kortix: One session, one sandbox, one branch; work lands through a change request
    kortix_docs: https://kortix.com/docs/work/sessions
```

Ten controls fit in one file, so the whole set is readable in a sitting before a review rather than during one. The `kortix` line is our own answer to the same control, and on two of the ten it is a concession rather than a capability: no outbound allowlist is documented, and a runtime secret is a real value in the session. One row pairs a capability with the limit printed beside it. The Hooks entry quotes the admin-defined MCP hooks on offer, and the same page adds that "MCP hooks do not provide a complete Compliance API audit trail", so the `kortix` column answers that row with what gets recorded.

## What the check does to that file

The loop is one pass over the file: request each control's page, search its text for the quoted sentence, and report the controls whose sentence is no longer there. The quote and its URL stay with the control, so the evidence ages out on a date anyone can read.

```python
import re, sys, urllib.request, yaml

spec = yaml.safe_load(open("rows.yaml"))
sources = spec["sources"]
pages, missing = {}, []

def flat(s):
    s = s.replace("\u2019", "'").replace("\u00a0", " ")
    return re.sub(r"\s+", " ", s).strip().casefold()

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=45) as r:
        html = r.read().decode("utf-8", "ignore")
    html = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", html)
    return flat(re.sub(r"(?s)<[^>]+>", " ", html))

for item in spec["rows"]:
    url = sources[item["source"]]
    if url not in pages:
        try:
            pages[url] = fetch(url)
        except Exception:
            pages[url] = None
            print("unreadable:", url)
    if pages[url] is None:
        continue
    if flat(item["quote"]) not in pages[url]:
        missing.append(item["control"])
        print("quote gone:", item["control"], url)

print(f"{len(spec['rows'])} controls, {len(missing)} quotes missing")
sys.exit(1 if missing else 0)
```

Run it beside `rows.yaml` and it takes a few seconds. A quote that fails is not a bug in the file. The vendor rewrote, renamed or withdrew the control, and the control needs its sentence copied again from the new page.

## What it found, and the two pages it could not read

All ten quotes were on the page on 2026-10-21, so the control set is current. Three things can still put a control beyond a quote, and the first is a page that opens in a browser and nowhere else. chatgpt.com/business/enterprise and OpenAI's 2023 launch post are cited beside the list and behave that way, so every cell taken from them stays unquoted until someone reads the page by hand and dates the reading.

The second is a control that lives only in a sales conversation, which has nothing to search for. Data-processing terms, a sub-processor list, a pen-test summary available on request: all of it decides deals and none of it sits on a page. Ask for the sentence in writing and keep the answer with the contract.

The third is a control the vendor implements and never documents. An allowlist ships and the page never describes it, so there is no sentence to search for and no quote to put in the record.

## The control page says more than the lists made from it

Four sentences from the same overview, each a limit on a control it also offers:

- "These user-visible records don't establish Compliance API export or a complete administrator-visible execution history."
- "MDM and legacy managed-device requirements rank above Agent Security."
- "Local computer access with Work Cloud does not provide strict zero data retention."
- "Data residency and inference residency cover only eligible content and supported workloads, regions, and configurations."

Those are why the quotes stay verbatim. In a list of forty cells, read the ones that read badly first.

## What our own stack has to answer

The same questions are worth putting to any platform you would run the work on. Which rule wins when two disagree? On Kortix the answer sits in [the manifest reference](https://kortix.com/docs/project/manifest#policy-and-policies). Project rules are checked first, then the connector's own policies, and the first match wins. A team writes this into `kortix.yaml`, and the conditions narrow a rule to particular arguments:

```yaml
policy:
  default_mode: risk
policies:
  - match: gmail.send_email
    action: require_approval
    conditions:
      - arg: to
        match: "*@example.com"
  - match: gmail.send_email
    action: block
```

`risk` runs a read and sends a write or a destructive call to approval. The same page is explicit about where its own checking stops. `kortix validate` does not check `policy` or `policies`, a malformed rule is skipped when connectors sync, and the error shows up afterwards in the connector settings. A vendor that names the parts of its own file it does not check is easier to believe about the parts it does.

What gets recorded, and who can read it, are two different answers. Kortix writes one record for every request that reaches the API. An agent's record names the person the agent acted for ([accounts](https://kortix.com/docs/accounts#audit-log)). Every action is recorded. Reading, exporting and streaming the audit log depend on the plan. Records sit in the database for 90 days, move to a locked archive until 365, and are deleted after that.

## Where the agent runs, and what our docs leave out

Sessions run on Platinum sandboxes. On a self-hosted install the instance runs the platform, API and database included. It has to be reachable from the internet so those sandboxes can call back ([self-hosting](https://kortix.com/docs/host)). One isolated sandbox per session. Each session has its own isolated machine and branch.

What the docs leave unsaid matters as much as what they state. No outbound allowlist is documented for a sandbox's own traffic. The network rule that does exist is narrower. Connector calls refuse private and internal addresses, and a self-hosted instance can allow internal hosts by listing them in `KORTIX_CONNECTOR_EGRESS_ALLOW_HOSTS`.

## Use it on the next list you are handed

Nothing here needs our stack. Take the control list from whichever vendor sent you one and keep the five that decide your review. Find the sentence behind each on the vendor's own page. Keep the URL with it, run the loop before the renewal, and ask in writing where no sentence exists. An answer by email is all the evidence there will be, so date it.

Kortix is open source. Read it, fork it, audit it. Start at [kortix.com](https://kortix.com).
