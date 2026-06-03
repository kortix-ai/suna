# Demo lead qualification — runbook

Goal: stop tiny / unqualified prospects (1–10-person shops with no budget) from
booking demo + onboarding calls, capture every request, and reserve the
founder/SE calendar for real opportunities.

Three layers. Layer 1 ships in the repo; layers 2–3 are Cal.com config and are
the *unbypassable* part — do them, or the raw Cal URL stays open.

---

## Layer 1 — in-app qualifier (shipped, in code)

`apps/web/src/app/(home)/contact/page.tsx`

- "Book a demo" opens a short form first (name, work email, company name,
  company size, optional goal), not the calendar.
- Routing on submit:
  - **11+ employees → Cal booking** (`team/kortix/demo`), with the answers
    **prefilled** into the booking (see Layer 2 for how prefill matches).
  - **1–10 → self-serve panel** ("request received → start free", → `/auth`).
- Threshold lives in `COMPANY_SIZES[].qualifies` — edit there to retune.
- **Every** submission (qualified + disqualified) is POSTed to
  `/api/demo-request` and stored as a JSON blob in `public.contact_forms`
  (schema-agnostic — no migration when the form changes).

In-app onboarding ("Book a call with Marko") is separately gated to **paid
plans only** via `useShowPersonalContact()`
(`apps/web/src/hooks/use-show-personal-contact.ts`).

Read captured leads (anon can't SELECT by design — use the service role / SQL):

```sql
select created_at, data from public.contact_forms order by created_at desc;
```

> Limitation: a Cal.com booking URL is public. Anyone who already has the link
> can skip this form. Layer 1 is funnel polish + capture, not enforcement.

---

## Layer 2 — Cal booking questions (prefill contract + hard gate)

Cal.com → Event Type → **Advanced → Booking questions**. The in-app form
**prefills** by each field's **Identifier** — Cal silently ignores a prefill key
that doesn't match an identifier, and a dropdown value that isn't a verbatim
option. So these must match `contact/page.tsx` exactly:

| Cal Identifier | Type | Options (verbatim) | Prefilled from form |
|---|---|---|---|
| `name` (built-in) | — | — | ✅ Name |
| `email` (built-in) | Email | — | ✅ Work email |
| `Company_name` | Short text | — | ✅ Company name |
| `Company_size` | Select | `1-10` · `11-50` · `51-200` · `201-1000` · `1000+` | ✅ Company size |

Code contract (keep in sync):
- `CAL_FIELD_COMPANY_SIZE = 'Company_size'`, `CAL_FIELD_COMPANY_NAME = 'Company_name'`
- `COMPANY_SIZES[].value` mirrors the Cal options **verbatim** (plain hyphen `-`,
  not en-dash). `1-10` routes to self-serve; the rest qualify.

Tips:
- Enable **"Disable input if the URL identifier is prefilled"** on each field so
  visitors can't edit what they already told us.
- Mark fields **Required** so raw-link bookers must self-identify too.

---

## Layer 3 — Routing Form auto-reject (Cal.com Teams feature)

Cal.com → **Routing Forms** → same fields, then routes:

- `Company_size = 1-10` → **custom message / redirect** to `https://<app>/auth`
  ("Kortix is self-serve and free to start — no call needed").
- Otherwise → route to the `team/kortix/demo` event.

Point the public "Book a demo" links at the **Routing Form URL** so the form is
the only door. Optional: block free email domains (gmail/yahoo/…) on the email
question and bounce them to self-serve.

---

## Why this matters (data, 2026-06-03)

Audited booked attendees against prod Stripe + DB: essentially **none** were
active paying customers, and several (Kennedy Umege, Anthony Rivers, Vadim
Ilyinsky) had **no account at all** — i.e. they came through the **public Cal
link**, not the in-app widget. That's why Layer 1 alone isn't enough and
Layers 2–3 are required.
