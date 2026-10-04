---
recorded: 2026-10-02T10:44:42Z
incident_date: 2026-09-29
---
# Measure an email's raw HTML length before shipping a short template with a logo: SpamAssassin scores image emails under 3,200 bytes

**Rule:** Before you ship or shorten an email template that shows the logo, measure the raw HTML part (`html.length`, markup included) of its shortest variant. Keep it above 3,200 bytes. SpamAssassin's `html_image_only` treats a small HTML part with an `<img>` as an image-only email, whatever the visible text says. Authentication passing is not the whole check: run a seed test (mail-tester.com) and read the SpamAssassin rules it lists.

**Trigger surface:** editing `apps/api/src/lib/email/template.ts` (the shell), `apps/api/src/services/accounts/email.ts`, `apps/api/src/services/auth/send-email-hook/templates.ts`, or any other `renderEmail` caller; or answering a "lands in spam" report.

**Incident:** 2026-09-29, a workspace member reported that project invitation emails land in spam. The audit on 2026-10-02 found authentication clean: SES `us-east-2`, SPF pass on `bounce.kortix.com`, DKIM pass `d=kortix.com`, DMARC pass under `p=reject`, and the IP on no blocklist. A dev seed test scored 8.9/10. SpamAssassin added `HTML_IMAGE_ONLY_28` (0.726 with network tests, 2.799 without) because the invite HTML was 2,746 bytes with a logo `<img>`. All 11 shell emails measured 2,253 to 2,795 bytes. The rule's description says "bytes of words", but `Mail::SpamAssassin::HTML::parse` adds the raw HTML length.

**Enforcement:** `apps/api/src/__tests__/unit-notifications.test.ts` ("… stays above the image-only HTML window") renders both invite variants with the shortest origin and address and asserts more than 3,200 bytes. The other shell emails have no guard yet; the reauthentication code email is 2,731 bytes (`HTML_IMAGE_ONLY_28`).
