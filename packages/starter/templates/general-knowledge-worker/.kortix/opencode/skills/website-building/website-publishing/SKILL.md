# Publishing & Going Live

Guardrails for taking a website from local preview to a real, shareable URL. The parent `website-building` skill is already loaded — this file only adds the rules for *when* and *how* to publish.

Default posture: **everything stays a local preview until the user explicitly asks to go live.** Previewing is free and re-runnable; publishing is a deliberate, opt-in step that puts your code on a URL other people can reach.

If you are a subagent (anything other than the main agent), do not publish. Publishing needs user approval, and approval only routes back to the main thread. Finish the build, verify the preview, and hand the project path back to the main agent to take it live.

---

## When to publish

Publish only when the user asks for it in plain terms:

- "publish this" / "make it live" / "ship it for real"
- "give me a real / permanent / shareable link"
- "put this online" / "I want to send this to people"

Until then, keep delivering the preview — a local server plus the auto-proxied sandbox URL described in `shared/09-technical.md`.

Three rules that keep you out of trouble:

- **Never publish unprompted.** If the site looks finished and you suspect they'll want it live, *offer* — "Want me to publish this to a shareable URL?" — and wait for the yes.
- **Don't auto-republish after edits.** Re-running a local preview is fine any time. Pushing changes to a live URL is not — offer it, then wait.
- **Don't publish from memory.** If you believe a site went live earlier but the current state doesn't confirm it's still up, assume the user took it down on purpose. Re-publish only on a fresh, explicit request — never from a stale "this was published" note.

---

## Taking a published site down

You cannot quietly revoke a live URL, and you must never fake a takedown by overwriting the site with a blank page, a placeholder, or a redirect. That leaves confusing, half-broken state and is not a real unpublish.

When the user wants a site taken down, made private, or restricted:

- Point them at the real control for wherever it's hosted — their deploy platform's dashboard, or simply stopping the shared sandbox preview.
- Leave the project files untouched so they can re-publish later.
- If they want internal-only access, say plainly that a shared preview URL is public-by-link, and recommend the hosting platform's access controls for genuine privacy.

> I can't pull a live URL down from here. Open your hosting dashboard (or stop the shared preview) to take it offline — I won't swap in placeholder content. The project files stay here so you can republish whenever you want.

---

## How publishing works in Kortix

There is no magic one-click deploy tool. "Publishing" resolves to one of two things, in priority order:

1. **The project's own deploy workflow.** If the repo already targets a host — Vercel, Cloudflare, a Dockerfile, a CI deploy step — use that exact workflow. Don't invent a competing one.
2. **The shared sandbox preview URL.** With no real deploy target, the live link is the same sandbox preview URL you already use for QA: Kortix proxies the running server's port to a shareable URL (see `shared/09-technical.md`). The exact same code serves both preview and "published" — routing, paths, and assets don't change.

Either way: **verify locally first**, then run the security review below before anything reaches the public.

---

## Before you publish

### 1. Verify the live build, not just the source
Start the server with `pty_spawn`, run the full Visual QA pass from the parent skill, and confirm the *built* output actually works. Don't grep the source and assume — exercise the real URL.

### 2. Run the pre-publish security review
See the section below. This is mandatory, every publish.

### 3. Flag runtime-only dependencies that won't survive publishing
Some things only work while the site runs *inside the Kortix agent sandbox during development*. They break the moment the site stands on its own:

- **LLM / media features tied to local-only credentials.** API keys you set in the dev environment aren't automatically present in a standalone deployment. Anything calling OpenAI / Anthropic / ElevenLabs / etc. — including the `shared/llm-api/` helpers — needs real production credentials provisioned on the host, or it fails. See `shared/20-llm-api.md`.
- **Kortix tool / connector calls.** Anything that reaches back into the agent runtime or its connectors at request time has no bridge once the site is deployed on its own.

Scan before publishing:

```bash
grep -rn -E "(ANTHROPIC_API_KEY|OPENAI_API_KEY|ELEVENLABS_API_KEY|generate_image|generate_video|generate_audio)" \
  --include='*.py' --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' \
  --exclude-dir=node_modules --exclude-dir=dist . 2>/dev/null
```

For each hit, pick one:

- **Refactor it out** — bake LLM/media output as static assets at build time, or move the API call into a build step and cache the result. Static-first is the cleanest outcome.
- **Provision it for production** — confirm the deploy target has the real credentials and that the dependency is intentional.
- **Or tell the user it'll be degraded** and let them choose: publish anyway with the feature broken, or keep it as a preview where everything works.

### 4. Disclose data-persistence limits
If the app stores user-submitted data in SQLite, an in-memory store, or any local file, that data is not durable on an ephemeral host. Say so plainly **before** publishing — once per publish, even if the user already approved other warnings. Keep it non-technical:

> One note before I publish: this app keeps submitted data in a built-in local store. That's great for a prototype but isn't durable production storage. For data that needs to survive, I'd connect Supabase or deploy on a host with managed storage.

For real multi-user persistence, use Supabase (database only — don't lean on its auth for a published static site). Provision the Supabase URL and anon key as real production environment variables on the host; never hardcode them into the shipped bundle.

### 5. Use secure cookies behind the preview proxy
Sites served through the sandbox preview proxy sit behind Kortix's domain. Use `Secure`, explicitly-named, properly-scoped session cookies instead of relying on framework defaults, so sessions behave the same in preview and when shared.

---

## Pre-publish security review

Before publishing, run a security-review **subagent** with the prompt in `security_subagent_prompt.md` (this directory). The checks are mostly grep/bash, so a fast, cheap model is fine. Pass it two things:

- `{{project_path}}` — the absolute path to the project.
- `{{context}}` — one or two lines on what the site is, who it's for, and whether it handles user data (e.g. "public marketing page, no user data" vs "small-team task tracker backed by Supabase"). This lets the reviewer calibrate severity.

Act on the report:

- **BLOCK** (exposed secrets, leaked credentials, critical exploitable vulnerabilities): fix automatically where you can — pull hardcoded keys into environment variables, add `.env` to `.gitignore`. If a fix needs the user, surface it and stop.
- **WARN**: present to the user and let them decide whether to proceed.

Never publish over an unaddressed BLOCK finding.
