/**
 * The Kortix Enterprise Subscription Terms, as published (`/legal?tab=enterprise`).
 *
 * English only, like the Terms of Service. Same Markdown shape (`##` sections,
 * paragraphs, `-` bullets, `1.` lists, `**bold**`); `legal/page.tsx` renders
 * it. The license text itself is `ee/LICENSE` in the repository. Prices never
 * appear here: each order states its own.
 */
export const ENTERPRISE_TERMS_LAST_UPDATED = 'October 28, 2026';

export const ENTERPRISE_TERMS = `These Kortix Enterprise Subscription Terms (the "Enterprise Terms") are between Kortix AI Corp, a Delaware corporation ("Kortix"), and the organization that signs or accepts an order for Kortix Enterprise ("Customer"). They add to the Kortix Terms of Service (the "Terms"). The Terms govern everything these Enterprise Terms do not change. If the two conflict on Kortix Enterprise, these Enterprise Terms control.

Kortix is open source under the Apache License 2.0. The code in directories named "ee" is licensed under the Kortix Enterprise License (the "Enterprise License"), published as ee/LICENSE in the Kortix source code. Production use of that code needs a subscription under these Enterprise Terms.


## 1. What Customer gets

**Enterprise features.** For the subscription term, Customer may use the Kortix Enterprise features: SAML single sign-on, SCIM directory provisioning, custom roles, policies and groups, and audit log access, export and webhooks.

**On Kortix Cloud.** Kortix turns the Enterprise features on for the accounts the order names.

**On Customer's own infrastructure.** Kortix grants Customer the right of production use under the Enterprise License, section 3, for the deployments the order names, and issues a license key for them.

**Support.** Kortix provides the support the order states.


## 2. Orders

**The order decides scope and fees.** Each order states the accounts or deployments it covers, the term, the fees, and how Customer pays. Customer pays the fees in the order under the Terms.

**Ways to order.** Customer can accept an offer in the Kortix app, sign an order form, or receive an invoice. Each is an order.


## 3. Term and renewal

**Term.** A subscription runs for the term in the order. When the order states no term, the term is 12 months from the start date.

**Renewal.** A subscription renews only when the order says so, or when both parties agree in writing.


## 4. License keys

**Use.** A license key is for the deployments in the order only. Customer keeps it confidential and does not share it with a third party.

**New term, new key.** Each key carries Customer's name and an end date. Kortix issues a new key for each renewed term.

**The key records the license; it is not the license.** Production use of Enterprise code needs an active subscription, whether or not a key check runs or has been changed.


## 5. When a subscription ends

**Kortix Cloud.** The Enterprise features stop at the end of the term. SAML single sign-on and SCIM stay on for 14 more days so that no one is locked out. Customer's data stays under the Terms.

**Own infrastructure.** Customer stops production use of Enterprise code at the end of the term. Development, testing and evaluation stay free under the Enterprise License, section 2.

**Warnings.** Kortix sends a notice 30, 7 and 1 days before a subscription that does not renew ends.


## 6. Compliance with the license

**Records.** On reasonable written request, at most once a year, Customer confirms in writing which deployments use Enterprise code in production.

**Fixing a gap.** If Customer uses Enterprise code in production beyond its subscription, Customer orders the missing scope within 30 days of written notice.


## 7. Everything else

The Terms apply to the subscription, including payment, data protection and the Data Processing Addendum, security, confidentiality, warranties, indemnification, limits of liability, termination, and governing law and venue (Delaware).

Questions about these Enterprise Terms: legal@kortix.com.`;
