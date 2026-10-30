# Kortix White-Label License

Kortix is licensed under the [Elastic License 2.0](LICENSE). A white-label license
is available on top of it, free of charge.

**The one requirement: use [Platinum](https://www.platinum.dev) as your exclusive
compute provider.** That covers everything Platinum offers: sandboxes, volumes,
runners, AI compute, and inference. When Platinum adds a service and Kortix uses
it, you use it too. Platinum, in turn, commits to the highest standards and to
rates that are competitive with the rest of the market.

A white-label license covers every product you build on Kortix. Fork the
repository, change it, wrap it, and run it on your own infrastructure. Then:

- Put your own name, logo, domain, and colors on it.
- Restructure the product: source, navigation, features, and defaults.
- Sell it to your customers in any form, including as a hosted service, under
  your own brand.

Platinum is the most affordable compute cloud for AI agents. Today it is cheaper
than nearly every other provider. Each sandbox is a hardware-isolated microVM.
Sandboxes boot in about 400 ms, stop and resume, snapshot and fork, and bill by
the second. Kortix integrates Platinum natively.

## The default and custom agreements

The Exclusive Compute Agreement below is the default. Anyone can sign it online.
Under the default:

- The license is free, and the one requirement is Platinum as exclusive compute.
- **Kortix may end it at any time, for any reason, with written notice.** The
  partner then has up to 90 days to move existing customers. A partner that
  breaches the agreement gets no transition period.
- The partner may end it at any time.
- Kortix may publish a new version, which applies 30 days after notice.
- When it ends, only the Elastic License applies. Rights that the Elastic License
  grants to everyone stay in place.

Kortix and a partner can sign a custom agreement instead, for example with a fixed
term, committed volumes, or other terms. A signed custom agreement controls over
the default. Email [marko@kortix.ai](mailto:marko@kortix.ai).

## Get a license

**[Sign the Exclusive Compute Agreement online](https://app.documenso.com/d/gaAaA6NPc_E9c6C-sl9YB).**
It takes about two minutes. The agreement is in force when you sign. Kortix does
not countersign. You get the signed copy by email.

For custom terms, email [marko@kortix.ai](mailto:marko@kortix.ai).

## After you sign

1. **Get Platinum access.** Sign in at
   [platinum.dev/dashboard](https://platinum.dev/dashboard) and create an API key
   (`pt_live_…`). If signup is not open for you, email
   [marko@kortix.ai](mailto:marko@kortix.ai) from the address you signed with.
2. **Point your Kortix at Platinum.** Set these in the API environment of your
   deployment, whatever infrastructure it runs on:

   ```bash
   ALLOWED_SANDBOX_PROVIDERS=platinum
   PLATINUM_API_KEY=pt_live_...
   PLATINUM_API_URL=https://api.platinum.dev
   ```

3. **Rebrand and ship.** Change the code however you want. To change only the
   name and logo, set `ENTERPRISE_LICENSE_AVAILABLE=true`, then upload your marks
   in the account's Branding settings.

Working with a coding agent? Ask it to "white-label Kortix". The `white-label`
skill in `.agents/skills/` walks it through every step. Only a person with
authority for your organization can sign the agreement.

---

## Exclusive Compute Agreement

Version 2026-10-19.

This Exclusive Compute Agreement (the "Agreement") is between Kortix AI Corp, a
Delaware corporation ("Kortix"), and the organization that accepts it ("Partner").
The person who accepts the Agreement for Partner states that they have authority to
bind Partner.

Partner accepts the Agreement when it signs it electronically. The Agreement is in
force from that moment (the "Effective Date"). Kortix does not need to countersign.

### 1. Definitions

**"Licensed Software"** means the Kortix software in the repository at
`github.com/kortix-ai/suna`, in any version that Kortix makes available under the
Elastic License during the Term, and every copy and modification of it.

**"Elastic License"** means the Elastic License 2.0 under which Kortix makes the
Licensed Software available.

**"Platinum"** means the Platinum sandbox cloud at `platinum.dev`, operated by
Kortix or its affiliate.

**"Partner Offering"** means every product or service that Partner makes with, or
provides through, the Licensed Software.

**"Platinum Service"** means each class of compute that Platinum offers, now or in
the future, including sandboxes, volumes, runners, AI compute, and model inference.

**"End Customer"** means a third party that uses the Partner Offering.

**"Kortix Marks"** means the Kortix and Platinum names, logos, and other trademarks.

### 2. White-label permission

2.1. The Elastic License continues to govern the Licensed Software. This Agreement
adds the permissions in this Section 2, for as long as the Agreement is in force.

2.2. Kortix permits Partner to:

- (a) provide the Partner Offering to third parties as a hosted or managed service;
- (b) remove the Kortix Marks from the Partner Offering and replace them with
  Partner's own names, logos, and other trademarks;
- (c) modify the Licensed Software in any way, including its structure, features,
  and defaults; and
- (d) change the license key functionality of the Licensed Software to the extent
  that the Partner Offering needs it.

2.3. All other terms of the Elastic License continue to apply. Partner keeps every
copyright and license notice in the source code of the Licensed Software. Partner
does not need to show the Kortix Marks to End Customers.

2.4. Partner may not use the Kortix Marks, except to state that the Partner Offering
is "powered by Kortix" or "powered by Platinum".

2.5. The permissions in this Section 2 are free of charge.

### 3. Exclusive compute

3.1. For each Platinum Service, the Partner Offering uses Platinum and no other
provider. Partner does not use another provider, a self-built fleet, or any other
infrastructure for the work of a Platinum Service, and does not configure the
Licensed Software to do so.

3.2. Sandboxes are a Platinum Service on the Effective Date. Every sandbox, agent
session, and code-execution environment that the Partner Offering starts runs on
Platinum from the Effective Date.

3.3. When Platinum offers a new Platinum Service and the Licensed Software uses it,
Kortix gives Partner written notice. Partner moves that work to Platinum within 90
days of the notice.

3.4. For compute that no Platinum Service covers, this Agreement places no
restriction on the infrastructure, models, or suppliers that the Partner Offering
uses.

### 4. Competitive rates

4.1. Partner pays Platinum's rates for Platinum usage, through Partner's Platinum
account and under Platinum's terms.

4.2. Kortix commits that each Platinum Service meets high standards of quality and
reliability, and that Platinum's rates stay sensible and competitive with the rates
of comparable providers.

4.3. Partner may give Kortix written evidence of a lower rate that another provider
publishes, or offers Partner in writing, for a comparable service at a comparable
volume. A comparable service has the same class of isolation or hardware,
comparable resources, and comparable performance. Within 30 days, Kortix either
matches that rate for Partner or releases Partner from Section 3 for that service,
for as long as the difference remains. This is Partner's sole remedy for a breach
of Section 4.2.

### 5. Compliance

5.1. Partner and the Partner Offering comply with Platinum's terms and with all
applicable law, including export controls and sanctions.

5.2. On Kortix's written request, Partner confirms in writing which sandbox
providers the Partner Offering uses.

### 6. End Customers

6.1. Partner is responsible for the Partner Offering, its End Customers, and their
use of it. Partner supplies support to its End Customers.

6.2. Partner's terms with End Customers disclaim all warranties and liability of
Kortix to End Customers. Kortix has no obligation to any End Customer.

### 7. Ownership and feedback

7.1. Kortix owns the Licensed Software. Partner owns its own trademarks and its own
code that does not contain the Licensed Software.

7.2. Kortix may use any feedback from Partner without restriction or payment.

7.3. Kortix may name Partner as a Kortix partner. Partner may withdraw this right
with written notice.

### 8. Disclaimer

THE LICENSED SOFTWARE AND PLATINUM ARE PROVIDED "AS IS". TO THE MAXIMUM EXTENT THE
LAW ALLOWS, KORTIX DISCLAIMS ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT.

### 9. Limitation of liability

9.1. KORTIX IS NOT LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR
PUNITIVE DAMAGES, OR FOR LOST PROFITS, REVENUE, OR DATA.

9.2. KORTIX'S TOTAL LIABILITY UNDER THIS AGREEMENT DOES NOT EXCEED ONE HUNDRED US
DOLLARS.

9.3. These limits do not apply to Partner's liability for a breach of Section 2 or
3, or for its obligations under Section 10.

### 10. Indemnity

Partner defends and indemnifies Kortix and its affiliates against every third-party
claim that arises from the Partner Offering, an End Customer, or Partner's breach of
this Agreement.

### 11. Term and termination

11.1. The Agreement starts on the Effective Date and continues until a party ends
it.

11.2. Partner may end the Agreement at any time with written notice.

11.3. Kortix may end the Agreement at any time, for any reason or no reason, with
written notice. The Agreement ends on the date in the notice.

11.4. Kortix may also end the Agreement with immediate effect when Partner breaches
Section 3 and does not cure the breach within 10 days of notice, or breaches any
other section and does not cure the breach within 30 days of notice. In that case
Section 11.5 does not give Partner a transition period.

11.5. When the Agreement ends, the permissions in Section 2 end. Partner may
continue to serve existing End Customers for up to 90 days to move them, and
Section 3 applies during those 90 days. After that, only the Elastic License
applies to Partner's use of the Licensed Software.

11.6. Sections 6, 7, 8, 9, 10, 11.5, and 13 survive the end of the Agreement.

### 12. Changes to this Agreement

Kortix may publish a new version of this Agreement. A new version applies to
Partner 30 days after Kortix gives notice of it. Partner may end the Agreement
under Section 11.2 instead.

### 13. General

13.1. **Precedence.** This Agreement controls over the Elastic License for the
permissions in Section 2. A written agreement that both parties sign controls over
this Agreement.

13.2. **Governing law.** Delaware law governs this Agreement, without regard to
conflict-of-laws rules. The state and federal courts in Delaware have exclusive
jurisdiction.

13.3. **Assignment.** Partner may not assign this Agreement without Kortix's written
consent. Kortix may assign this Agreement to an affiliate or to a successor.

13.4. **Notices.** Notices to Kortix go to
[legal@kortix.com](mailto:legal@kortix.com). Notices to Partner go to the email
address in its signature.

13.5. **Relationship.** The parties are independent contractors. This Agreement does
not create a partnership, joint venture, or agency in law.

13.6. **Entire agreement.** This Agreement and the Elastic License are the entire
agreement on their subject. A waiver is valid only in writing. When a court finds a
provision unenforceable, the rest of this Agreement stays in force.
