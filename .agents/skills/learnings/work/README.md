# Work in progress: plans, designs, open thoughts

The ledger in `entries/` records rules paid for with incidents. This folder holds
the other half of the project's memory: the thinking behind work that is
planned, in flight, or parked, so another person or agent can pick it up.

- One folder per topic. Its `README.md` starts with frontmatter (`title`,
  `status`, `owner`, `updated`), then the problem, the files, and how to pick
  it up.
- Living documents: edit them in place. Keep a dated `decisions.md` when a topic
  has decisions.
- Same data rules as everywhere: no customer names, personal data, or real
  prod IDs.
- When the work ships, keep the folder and set `status` to what shipped and
  where (PR, merge SHA).

## Topics

| Topic | Status |
|---|---|
| [`goals-and-workflows/`](goals-and-workflows/README.md) | stage 1 merged on dev (flag `goals`); stage 2 planning |
| [`email-cost-passthrough/`](email-cost-passthrough/README.md) | parked: meter managed Resend inboxes and emails per account |
