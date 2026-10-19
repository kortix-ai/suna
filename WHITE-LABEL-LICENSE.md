# Kortix White-Label License

Put your own name and logo on Kortix. Restructure it as you need. Sell it to your
customers as your own product. The cost is one commitment: your Kortix runs on
Kortix compute.

**To get a license, email [marko@kortix.ai](mailto:marko@kortix.ai).** You get the
Standard White-Label Terms below to sign online. A larger deal adds an Order Form
on top of them.

## Summary

This section is a plain-language summary. The Standard White-Label Terms below
are the binding text.

### What you get

- **Your brand.** Remove the Kortix name, logo, and colors from the product. Use
  your own name, logo, domain, colors, and copy.
- **Your structure.** Change the source, the navigation, the features, and the
  defaults. Build your own frontend on `@kortix/sdk`. `apps/whitelabel-demo` is a
  complete reference app for that path.
- **The hosted-service right.** The [Elastic License 2.0](LICENSE) does not allow
  you to offer Kortix to third parties as a hosted or managed service. A
  white-label license does.
- **Kortix compute and inference.** Sandboxes on Platinum and model inference
  from Kortix, at partner rates.

### What you commit to

1. **Exclusive compute.** Every sandbox your product starts runs on Platinum,
   through Kortix. In this repo that is `ALLOWED_SANDBOX_PROVIDERS=platinum`. You
   do not run sandboxes on Daytona, E2B, another provider, or your own fleet.
2. **Cloud infrastructure on Kortix.** When you operate your product as a cloud
   platform for others, it runs on Kortix compute. That covers sandboxes,
   hosting, and every other class of compute Kortix offers.
3. **Kortix inference.** When Kortix offers inference for a model your product
   uses, including GPU inference, you buy that model's inference from Kortix.
4. **Future services.** Kortix gets the first right to supply any new compute,
   inference, or hosting service your product needs.

### Why Platinum

Platinum is the most affordable sandbox cloud for AI agents. Each sandbox is a
hardware-isolated microVM. Sandboxes boot in about 400 ms, stop and resume,
snapshot and fork, and bill by the second. Kortix integrates Platinum natively.

The compute commitment is not a cost to you. You get one supplier for sandboxes
and inference, at partner rates. You do not build or operate a sandbox fleet.
Your product runs on the same sandbox provider that Kortix builds against.

### Two modes

| | Private mode | Platform mode |
|---|---|---|
| Who uses it | Your organization, or customers you deploy for | Third parties who sign up for your hosted product |
| What you sign | The Standard White-Label Terms | The Standard White-Label Terms and an Order Form |
| Compute | Sandboxes on Platinum | Sandboxes and all cloud infrastructure on Kortix compute |
| Inference | From Kortix, when Kortix offers the model | From Kortix, when Kortix offers the model |

### Deal structures

The standard deal is the compute and inference commitment. An Order Form can add
one or more of these:

- a fixed license fee, annual or one-time;
- a revenue share on your product's revenue;
- a minimum compute or inference commitment;
- equity, a warrant, or another strategic investment term;
- co-selling, a reseller territory, or other partnership terms.

Kortix and the partner agree these case by case. Email
[marko@kortix.ai](mailto:marko@kortix.ai) to start.

### Relation to the open license

The [Elastic License 2.0](LICENSE) still applies to everyone without a
white-label license. You may run Kortix for your own organization under it. You
need a white-label license to offer Kortix to third parties as a hosted service,
to remove or change the license key functionality, or to replace the Kortix brand
for your customers.

---

## Standard White-Label Terms

Version 2026-10-19.

These Standard White-Label Terms (the "Terms") are a legal agreement between
Kortix AI Corp, a Delaware corporation ("Kortix"), and the organization that
accepts them ("Partner"). The person who accepts the Terms for Partner states
that they have authority to bind Partner.

Partner accepts the Terms when it signs them electronically or when it signs an
Order Form that references them. The Terms apply from the date of acceptance
(the "Effective Date").

### 1. Definitions

**"Licensed Software"** means the Kortix software in the repository at
`github.com/kortix-ai/suna`, in any version that Kortix makes available during the
Term, and every copy and Modification of it.

**"Modification"** means any change to, derivative work of, or addition to the
Licensed Software, by Partner or for Partner.

**"Partner Offering"** means every product or service that Partner makes with, or
provides through, the Licensed Software.

**"Partner Brand"** means Partner's names, logos, domains, and other trademarks.

**"Kortix Marks"** means the Kortix and Platinum names, logos, and other trademarks.

**"End Customer"** means a third party that uses the Partner Offering.

**"Kortix Compute"** means sandboxes on Platinum, and every other class of compute,
hosting, or storage that Kortix or its affiliates offer, supplied through Kortix.

**"Kortix Inference"** means model inference, including GPU inference, that Kortix
or its affiliates offer.

**"Order Form"** means a document that references these Terms and that both parties
sign.

**"Private Mode"** means use of the Partner Offering only by Partner, its
affiliates, and End Customers for whom Partner operates a dedicated deployment.

**"Platform Mode"** means any use of the Partner Offering that is not Private Mode,
including a hosted or managed service that End Customers can sign up for.

### 2. License grant

2.1. Subject to Partner's compliance with these Terms, Kortix grants Partner a
non-exclusive, non-transferable, worldwide license during the Term to:

- (a) use, copy, and modify the Licensed Software;
- (b) remove the Kortix Marks from the user interface of the Partner Offering and
  replace them with the Partner Brand;
- (c) operate the Partner Offering for End Customers in Private Mode; and
- (d) operate the Partner Offering in Platform Mode, only when an Order Form
  authorizes Platform Mode.

2.2. Partner may sublicense only the right to use the Partner Offering, and only to
End Customers. Partner may not sublicense the Licensed Software in source code
form.

2.3. Partner may change the license key functionality of the Licensed Software
only to the extent that it is necessary to operate the Partner Offering under
these Terms.

2.4. Kortix reserves all rights that these Terms do not expressly grant.

### 3. Exclusive compute

3.1. **Sandboxes.** The Partner Offering runs every sandbox, agent session, and
code-execution workload on Kortix Compute. Partner does not use another sandbox
provider or its own sandbox fleet for the Partner Offering. Partner does not
re-enable another sandbox provider in the Licensed Software.

3.2. **Cloud infrastructure.** In Platform Mode, the Partner Offering runs all of
its cloud infrastructure on Kortix Compute, for each class of compute that Kortix
offers. For a class that Kortix does not offer, Partner may use another supplier
until Kortix offers that class. Partner then moves that class to Kortix Compute
within 90 days of Kortix's written notice.

3.3. **Inference.** When Kortix offers inference for a model that the Partner
Offering uses, the Partner Offering buys that model's inference from Kortix
Inference. Partner moves that model to Kortix Inference within 30 days of
Kortix's written notice.

3.4. **First right on new services.** Before Partner buys a new class of compute,
inference, or hosting for the Partner Offering from a third party, Partner offers
Kortix the opportunity to supply it. Kortix has 30 days to accept.

3.5. **Rates.** Kortix Compute and Kortix Inference are billed at the Kortix
partner rates in effect, or at the rates in an Order Form. Kortix may change the
partner rates with 30 days' written notice.

### 4. Fees and payment

4.1. Partner pays for Kortix Compute and Kortix Inference by usage. Partner pays
every additional fee in an Order Form, such as a license fee, a revenue share, or
a minimum commitment.

4.2. Invoices are due 30 days from the invoice date. Late amounts accrue
interest at 1.5% per month, or the maximum rate the law allows if that is lower.
Kortix may suspend Kortix Compute and Kortix Inference when an invoice is more
than 15 days late.

4.3. Fees exclude taxes. Partner pays all taxes on the fees, except taxes on
Kortix's net income.

4.4. Fees are non-refundable, except where these Terms state otherwise.

### 5. Reports and audit

5.1. Each month, Partner reports to Kortix the number of End Customers, the
Partner Offering's revenue when an Order Form includes a revenue share, and the
compute and inference suppliers that the Partner Offering uses.

5.2. Once per year, Kortix may audit Partner's compliance with these Terms, with
15 days' notice. When an audit finds an underpayment of more than 5%, Partner
pays the underpayment and the cost of the audit.

### 6. Brands

6.1. Partner may not use the Kortix Marks, except to state that the Partner
Offering is "powered by Kortix" with Kortix's prior written consent.

6.2. Partner does not need to show the Kortix Marks to End Customers. Partner
keeps every copyright and license notice in the source code of the Licensed
Software.

6.3. Partner grants Kortix the right to name Partner, and to show the Partner
Brand, as a Kortix partner. Partner may withdraw this right with written notice.

### 7. Ownership

7.1. Kortix owns the Licensed Software. Partner owns the Partner Brand.

7.2. Partner grants Kortix a perpetual, irrevocable, worldwide, royalty-free
license to use, copy, modify, and distribute every Modification. Partner gives
Kortix a copy of a Modification within 30 days of Kortix's written request.

7.3. Kortix may use any feedback from Partner without restriction or payment.

7.4. Partner does not use the Licensed Software, Kortix Compute, or Kortix
Inference to build a product that competes with Kortix Compute or Kortix
Inference.

### 8. End Customers

8.1. Partner is responsible for the Partner Offering, its End Customers, and their
use of it. Partner supplies support to its End Customers.

8.2. Partner's terms with End Customers protect Kortix at least as much as these
Terms. Those terms disclaim all warranties and liability of Kortix to End
Customers.

8.3. Kortix has no obligation to any End Customer.

8.4. Partner and the Partner Offering comply with the
[Kortix Terms of Service](https://kortix.com/legal) for their use of Kortix
Compute and Kortix Inference, and with all applicable law, including export
controls and sanctions.

### 9. Support and updates

Kortix may supply updates, support, or a service level. It does so only when an
Order Form includes them.

### 10. Confidentiality

Each party keeps the other party's non-public information confidential. It uses
that information only to perform these Terms. This obligation continues for 3
years after the Term ends, and without limit for trade secrets.

### 11. Disclaimer

THE LICENSED SOFTWARE, KORTIX COMPUTE, AND KORTIX INFERENCE ARE PROVIDED "AS IS".
TO THE MAXIMUM EXTENT THE LAW ALLOWS, KORTIX DISCLAIMS ALL WARRANTIES, EXPRESS OR
IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND
NON-INFRINGEMENT.

### 12. Limitation of liability

12.1. KORTIX IS NOT LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR
PUNITIVE DAMAGES, OR FOR LOST PROFITS, REVENUE, OR DATA.

12.2. KORTIX'S TOTAL LIABILITY UNDER THESE TERMS DOES NOT EXCEED THE FEES THAT
PARTNER PAID TO KORTIX UNDER THESE TERMS IN THE 12 MONTHS BEFORE THE EVENT THAT
CAUSED THE LIABILITY.

12.3. These limits do not apply to Partner's liability for fees, for a breach of
Section 3, 6, or 7, or for its obligations under Section 13.

### 13. Indemnity

Partner defends and indemnifies Kortix and its affiliates against every
third-party claim that arises from the Partner Offering, the Partner Brand, a
Modification, an End Customer, or Partner's breach of these Terms.

### 14. Term and termination

14.1. The Term starts on the Effective Date and runs for 1 year. It renews
automatically for 1-year periods. Either party may stop the renewal with 90 days'
written notice before the end of the current period.

14.2. Kortix may terminate these Terms with written notice when:

- (a) Partner breaches Section 3 and does not cure the breach within 10 days of
  notice;
- (b) Partner breaches any other section and does not cure the breach within 30
  days of notice;
- (c) Partner does not pay an invoice within 30 days of its due date; or
- (d) a competitor of Kortix acquires control of Partner.

14.3. When the Terms end, Partner stops distributing the Partner Offering and
stops using the Licensed Software outside the Elastic License 2.0. Partner may
continue to serve existing End Customers for up to 90 days to move them. Sections
3 and 4 apply during those 90 days.

14.4. Sections 4, 5, 7, 10, 11, 12, 13, 14.3, and 16 survive the end of the
Term.

### 15. Changes to these Terms

Kortix may publish a new version of these Terms. The new version applies to
Partner from its next renewal. An Order Form does not change when Kortix
publishes a new version.

### 16. General

16.1. **Precedence.** An Order Form controls over these Terms, and these Terms
control over the Elastic License 2.0, for the matters that they address.

16.2. **Governing law.** Delaware law governs these Terms, without regard to
conflict-of-laws rules. The state and federal courts in Delaware have exclusive
jurisdiction.

16.3. **Assignment.** Partner may not assign these Terms without Kortix's written
consent. Kortix may assign these Terms to an affiliate or to a successor.

16.4. **Notices.** Notices to Kortix go to
[legal@kortix.com](mailto:legal@kortix.com). Notices to Partner go to the email
address in its signature.

16.5. **Relationship.** The parties are independent contractors. These Terms do
not create a partnership, joint venture, or agency in law.

16.6. **Entire agreement.** These Terms and every Order Form are the entire
agreement on their subject. A waiver is valid only in writing. When a court finds
a provision unenforceable, the rest of these Terms stays in force.
