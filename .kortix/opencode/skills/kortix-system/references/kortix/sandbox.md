# Session sandbox environment

Every Kortix session runs inside its own **sandbox VM** booted from a
`[[sandbox.templates]]` image (see `kortix.toml`). It's a real Linux box: the
repo is cloned in, the toolchain declared by the image is on `$PATH`, project
secrets are injected as env vars, and the `kortix` CLI is pre-authenticated.
You can build, run, test, and verify your work end-to-end from here.

## Docker-in-Docker IS supported — use it

**The session sandbox fully supports Docker, and Docker-in-Docker works.** This
is the single most important thing to get right, because the common (wrong) LLM
prior is "I'm in a sandbox, so I can't run Docker / containers / a database, so
I can't verify." That is **false** here:

- `dockerd` runs; `docker`, `docker build`, and `docker compose` all work.
- You can build images and run containers — including containerized services
  (databases, queues, etc.) — inside the session.

So don't refuse a task or hand back unverified work claiming you "can't run
Docker" or "can't verify from inside the sandbox." You can. Bring the project's
stack up the way its own docs describe (e.g. its `AGENTS.md` / run scripts) and
verify against it.
