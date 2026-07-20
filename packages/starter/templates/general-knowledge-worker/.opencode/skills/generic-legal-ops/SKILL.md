---
name: generic-legal-ops
description: "Generic starter template — in-house legal operations toolkit: contract & NDA review against a negotiation playbook (clause analysis, GREEN/YELLOW/RED deviation classification, redlines), compliance & privacy (GDPR/CCPA/etc., DPA review, data subject requests), legal risk assessment (severity x likelihood scoring, risk register, escalation to outside counsel), meeting briefings for legal-relevant meetings, and canned/templated responses for common legal inquiries (DSRs, litigation holds, subpoenas, vendor questions). Triggers on: 'review this contract', 'review this NDA', 'redline this agreement', 'is this clause acceptable', 'DPA review', 'data subject request', 'GDPR/CCPA question', 'assess this legal risk', 'risk register', 'escalate to outside counsel', 'brief me for this meeting', 'prep me for this call', 'draft a response to this legal inquiry', 'litigation hold notice', 'template for'."
defaultProjectInstall: true
---

> **TODO — make this yours.** This is a generic starting template. Edit it to fit your own legal operation: your negotiation playbook and risk thresholds, your jurisdictions and applicable regulations, your escalation path to outside counsel, and your canned-response templates. Delete what you don't use.

# Legal Ops

Day-to-day in-house legal operations: reviewing contracts and NDAs against a playbook, staying on top of privacy compliance, scoring and escalating legal risk, prepping for meetings, and generating templated responses to routine legal inquiries. For drafting new legal documents from scratch (contracts, briefs, memos, complaints, ToS, privacy policies), use the `legal-writer` skill instead — it covers full-pipeline drafting with citation lookup and DOCX/verification tooling.

## Contract & NDA Review

### Contract Review Methodology

**Loading the playbook**: Before reviewing any contract, check for a configured negotiation playbook in the user's local settings — it defines the organization's standard positions, acceptable ranges, and escalation triggers per clause type. If none is available, offer to help create one, or proceed using widely-accepted commercial standards as a baseline.

**Review process**:
1. **Identify the contract type**: SaaS agreement, professional services, license, partnership, procurement, etc. — this affects which clauses are most material.
2. **Determine the user's side**: Vendor, customer, licensor, licensee, partner. This fundamentally changes the analysis (e.g., limitation-of-liability protections favor different parties depending on side).
3. **Read the entire contract** before flagging issues — clauses interact (an uncapped indemnity may be partially mitigated by a broad limitation of liability).
4. **Analyze each material clause** against the playbook position.
5. **Consider the contract holistically**: is the overall risk allocation and commercial balance reasonable?

### Common Clause Analysis

**Limitation of Liability** — review: cap amount (fixed $, multiple of fees, or uncapped); mutual vs. asymmetric cap; carveouts from the cap; consequential/indirect/special/punitive damages exclusion and its mutuality; carveouts from that exclusion; per-claim vs. per-year vs. aggregate application.
Common issues: cap set at a small fraction of fees paid; asymmetric carveouts favoring the drafter; broad carveouts that swallow the cap (e.g., "any breach of Section X" where X covers most obligations); no consequential-damages exclusion for one party's breaches.

**Indemnification** — review: mutual vs. unilateral; scope/triggers (IP infringement, data breach, bodily injury, breach of reps/warranties); whether capped (often subject to the overall liability cap, sometimes uncapped); procedure (notice, right to control defense, right to settle); mitigation duty; relationship to the limitation-of-liability clause.
Common issues: unilateral IP indemnification when both parties contribute IP; indemnification for "any breach" (too broad — effectively converts the cap to uncapped liability); no right to control defense; indemnification surviving termination indefinitely.

**Intellectual Property** — review: ownership of pre-existing IP (each party retains its own); ownership of IP developed during the engagement; work-for-hire scope; license grants (scope, exclusivity, territory, sublicensing); open source considerations; feedback clauses.
Common issues: broad IP assignment that could capture the customer's pre-existing IP; work-for-hire extending beyond deliverables; unrestricted feedback clauses granting perpetual irrevocable licenses; license scope broader than the business relationship needs.

**Data Protection** — review: whether a DPA is required; controller vs. processor classification; sub-processor rights/notification; breach notification timeline (72 hours for GDPR); cross-border transfer mechanism (SCCs, adequacy, BCRs); data deletion/return on termination; security requirements and audit rights; purpose limitation.
Common issues: no DPA when personal data is processed; blanket sub-processor authorization without notification; breach notice longer than regulatory requirement; no cross-border protections; inadequate deletion provisions. (See Compliance & Privacy section below for the full DPA checklist.)

**Term and Termination** — review: initial/renewal term; auto-renewal and notice period; termination for convenience (availability, notice, fees); termination for cause (cure period, definition of cause); effects of termination (data return, transition assistance, survival); wind-down obligations.
Common issues: long initial term with no termination for convenience; auto-renewal with short notice windows; no cure period for cause; inadequate transition assistance; survival clauses that effectively extend the agreement indefinitely.

**Governing Law and Dispute Resolution** — review: choice of law; mechanism (litigation, arbitration, mediation-first); venue/jurisdiction; arbitration rules and seat; jury waiver; class action waiver; prevailing-party fees.
Common issues: unfavorable/remote venue; mandatory arbitration on rules favoring the drafter; jury waiver without corresponding protections; no escalation step before formal dispute resolution.

### Deviation Severity Classification

**GREEN — Acceptable**: aligns with or is better than the standard position; minor, commercially reasonable variation. *Examples*: 18-month liability cap when standard is 12; mutual NDA term of 2 years when standard is 3; governing law in an established jurisdiction near the preferred one. *Action*: note for awareness, no negotiation needed.

**YELLOW — Negotiate**: outside the standard position but within a negotiable, market-common range. *Examples*: 6-month liability cap when standard is 12; unilateral IP indemnification when standard is mutual; auto-renewal with 60-day notice when standard is 90; acceptable-but-not-preferred governing law. *Action*: generate specific redline language, provide a fallback, estimate business impact of accepting vs. negotiating.

**RED — Escalate**: outside acceptable range, trips a defined escalation trigger, or poses material risk. *Examples*: uncapped liability or no limitation-of-liability clause; unilateral broad indemnification with no cap; assignment of pre-existing IP; no DPA offered when personal data is processed; unreasonable non-compete/exclusivity; problematic jurisdiction with mandatory arbitration. *Action*: explain the specific risk, provide market-standard alternative language, estimate exposure, recommend an escalation path.

### Redline Generation

1. **Be specific** — exact, insert-ready language, not vague guidance.
2. **Be balanced** — firm on critical points, commercially reasonable elsewhere; overly aggressive redlines slow negotiations.
3. **Explain the rationale** — 1-2 sentences suitable for sharing with counterparty's counsel.
4. **Provide fallback positions** for YELLOW items.
5. **Prioritize** — indicate must-haves vs. nice-to-haves.
6. **Consider the relationship** — adjust tone/approach for new vendor vs. strategic partner vs. commodity supplier.

Redline format:
```
**Clause**: [Section reference and clause name]
**Current language**: "[exact quote from the contract]"
**Proposed redline**: "[specific alternative language]"
**Rationale**: [1-2 sentences, suitable for external sharing]
**Priority**: [Must-have / Should-have / Nice-to-have]
**Fallback**: [Alternative position if primary redline is rejected]
```

### Negotiation Priority Framework

- **Tier 1 — Must-Haves (deal breakers)**: uncapped/materially insufficient liability protections; missing data protection for regulated data; IP provisions jeopardizing core assets; terms conflicting with regulatory obligations.
- **Tier 2 — Should-Haves (strong preferences)**: liability cap adjustments within range; indemnification scope/mutuality; termination flexibility; audit and compliance rights.
- **Tier 3 — Nice-to-Haves (concession candidates)**: preferred governing law (if alternative acceptable); notice-period preferences; minor definitional improvements; insurance certificate requirements.

Lead with Tier 1. Trade Tier 3 concessions to secure Tier 2 wins. Never concede on Tier 1 without escalation.

### NDA Screening Checklist

1. **Agreement structure**: type (mutual / unilateral-disclosing / unilateral-receiving) appropriate for the relationship; standalone agreement, not a confidentiality clause buried in a bigger contract.
2. **Definition of Confidential Information**: reasonably scoped (not "all information of any kind"); workable marking requirement if any (30 days from oral disclosure is standard); standard exclusions present; no problematic inclusions (public info, independently developed materials).
3. **Receiving-party obligations**: reasonable standard of care; use restricted to stated purpose; disclosure restricted to need-to-know parties under similar obligations; no impractical requirements (e.g., encrypt all communications, physical logs).
4. **Standard carveouts** (all must be present): public knowledge; prior possession; independent development; rightful third-party receipt; legal compulsion (with notice where permitted).
5. **Permitted disclosures**: employees; contractors/advisors/consultants under similar confidentiality; affiliates if needed; legal/regulatory.
6. **Term and duration**: agreement term 1-3 years standard; survival 2-5 years standard (longer for trade secrets); not perpetual.
7. **Return and destruction**: triggered on termination or request; reasonable scope; retention exception for legal/compliance/backup copies; certification (not sworn affidavit) is reasonable.
8. **Remedies**: injunctive relief acknowledgment is standard; no liquidated damages; mutual application.
9. **Problematic provisions to flag**: non-solicitation, non-compete, exclusivity, standstill (unless M&A context), broad residuals clause, IP assignment/license, audit rights — none of these belong in a standard NDA.
10. **Governing law/jurisdiction**: well-established commercial jurisdiction; consistent with governing law; no mandatory arbitration in standard NDAs.

### NDA Classification Rules

**GREEN — Standard approval**: all of — mutual (or correctly-directed unilateral); all standard carveouts present; term within 1-3yr / survival 2-5yr; no non-solicit/non-compete/exclusivity; no (or narrowly-scoped) residuals clause; reasonable jurisdiction; standard remedies; permitted disclosures cover employees/contractors/advisors; retention exception present; reasonably scoped definition. **Routing**: approve via standard delegation, no counsel review.

**YELLOW — Counsel review needed**: one or more of — broader-than-preferred (but not unreasonable) definition; longer-than-standard but market-range term (5yr/7yr survival); one missing carveout that's easy to add; narrowly-scoped residuals clause; acceptable-but-non-preferred jurisdiction; minor asymmetry in a mutual NDA; workable marking requirement; implied-but-not-explicit retention exception; unusual-but-non-harmful provisions. **Routing**: flag specific issues for a reviewer; likely resolved in one redline pass, 1-2 business days.

**RED — Significant issues**: any of — unilateral when mutual is required (or wrong direction); missing critical carveouts (esp. independent development or legal compulsion); non-solicitation/non-compete embedded; exclusivity/standstill without business context; unreasonable term (10+ years or unjustified perpetual); overbroad definition; broad residuals clause amounting to a license; hidden IP assignment/license; liquidated damages; unreasonable audit rights; highly unfavorable jurisdiction with mandatory arbitration; or the document isn't really an NDA (contains substantive commercial terms). **Routing**: full legal review, do not sign; negotiate, counterpropose the standard form, or reject. 3-5 business days.

### Common NDA Issues and Standard Positions

| Issue | Standard position / redline approach |
|---|---|
| Overbroad definition of Confidential Information | Narrow to non-public info disclosed for the stated purpose, with clear exclusions |
| Missing independent-development carveout | Add it — risk without it: claims that in-house work derived from counterparty's info |
| Non-solicitation of employees | Delete; doesn't belong in an NDA. If insisted upon, limit to targeted solicitation, 12-month term |
| Broad residuals clause | Resist; if required, limit to unaided memory of authorized individuals, exclude trade secrets/patentable info, no IP license |
| Perpetual confidentiality obligation | Replace with 2-5 years from disclosure/termination; offer a trade-secret carveout for longer protection |

### NDA Routing Table

| Classification | Recommended Action | Typical Timeline |
|---|---|---|
| GREEN | Approve and route for signature per delegation of authority | Same day |
| YELLOW | Send to designated reviewer with specific issues flagged | 1-2 business days |
| RED | Engage counsel for full review; prepare counterproposal or standard form | 3-5 business days |

## Compliance & Privacy

### Privacy Regulation Overview

**GDPR** (EU/EEA individuals, regardless of processor location): document lawful basis per processing activity (consent, contract, legitimate interest, legal/vital interest, public task); respond to data subject rights requests within 30 days (+60 for complex); DPIAs required for high-risk processing; notify the supervisory authority within 72 hours of a breach, affected individuals without undue delay if high-risk; maintain Article 30 records of processing; ensure safeguards for transfers outside the EEA (SCCs, adequacy, BCRs); appoint a DPO if required. Common touchpoints: vendor DPA review, privacy-by-design advice, supervisory authority inquiries, cross-border transfer mechanisms, consent/notice review.

**CCPA/CPRA** (businesses meeting revenue/data thresholds, CA residents): right to know, delete, opt-out of sale/sharing, correct (CPRA), and limit use of sensitive PI (CPRA); non-discrimination for rights exercise; privacy notice at/before collection; service-provider contracts must restrict PI use to the specified business purpose. Timelines: acknowledge within 10 business days, substantive response within 45 calendar days (+45 with notice).

**Other regulations to monitor**:

| Regulation | Jurisdiction | Key differentiators |
|---|---|---|
| LGPD | Brazil | GDPR-like; DPO required; ANPD enforcement |
| POPIA | South Africa | Information Regulator oversight; registration of processing |
| PIPEDA | Canada (federal) | Consent-based; OPC oversight; being modernized |
| PDPA | Singapore | Do Not Call registry; mandatory breach notice; PDPC enforcement |
| Privacy Act | Australia | Australian Privacy Principles; notifiable data breaches scheme |
| PIPL | China | Strict cross-border rules; data localization; CAC oversight |
| UK GDPR | United Kingdom | Post-Brexit; ICO oversight; UK-specific adequacy |

### DPA Review Checklist

**Required elements (GDPR Art. 28)**: subject matter and duration; nature and purpose of processing; type of personal data; categories of data subjects; controller obligations/rights.

**Processor obligations**: process only on documented instructions (subject to legal exceptions); confidentiality commitments from authorized personnel; Art. 32 security measures described; sub-processor requirements (written authorization — general or specific; notice of changes with right to object if general; sub-processors bound by the same obligations; processor remains liable); assistance with data subject rights, breach notification, DPIAs, and prior consultation; deletion or return of data on termination (controller's choice), with existing copies deleted unless legally required to retain; audit rights (or accepted third-party audit reports); breach notification without undue delay — ideally 24-48 hours, so the controller can meet its own 72-hour deadline.

**International transfers**: mechanism identified (SCCs, adequacy, BCRs); current EU SCCs (June 2021 version); correct module (C2P/C2C/P2P/P2C); transfer impact assessment where no adequacy decision; supplementary measures for identified gaps; UK Addendum if UK data is in scope.

**Practical**: DPA liability aligns with the main services agreement; DPA term aligns with the services agreement; processing locations specified/acceptable; security standards/certifications required (SOC 2, ISO 27001); adequate insurance.

**Common DPA issues**:

| Issue | Risk | Standard position |
|---|---|---|
| Blanket sub-processor authorization, no notification | Loss of control over the processing chain | Require notification + right to object |
| Breach notification > 72 hours | Prevents timely regulatory notification | Require notice within 24-48 hours |
| No audit rights (or third-party reports only) | Can't verify compliance | Accept SOC 2 Type II + audit right upon cause |
| No data-deletion timeline | Data retained indefinitely | Require deletion within 30-90 days of termination |
| No processing locations specified | Data could be processed anywhere | Require disclosure of locations |
| Outdated SCCs | Invalid transfer mechanism | Require current (2021) EU SCCs |

### Data Subject Request Handling

**Intake**:
1. Identify request type — access, rectification, erasure, restriction, portability, objection, opt-out of sale/sharing (CCPA/CPRA), limit use of sensitive PI (CPRA).
2. Identify applicable regulation(s) based on the data subject's location and the organization's presence/activities.
3. Verify identity proportionately to data sensitivity; don't over-demand documentation.
4. Log: date received, request type, requester identity, applicable regulation, response deadline, assigned handler.

**Response timelines**:

| Regulation | Initial ack | Substantive response | Extension |
|---|---|---|---|
| GDPR | Promptly (best practice) | 30 days | +60 days with notice |
| CCPA/CPRA | 10 business days | 45 calendar days | +45 days with notice |
| UK GDPR | Promptly (best practice) | 30 days | +60 days with notice |
| LGPD | Not specified | 15 days | Limited extensions |

**Exemptions to check before fulfilling**: legal claims defense/establishment; legal retention obligations; public interest/official authority; freedom of expression (for erasure); archiving/scientific/historical research. Organization-specific: litigation hold blocks deletion; regulatory retention periods; third-party rights impact.

**Response process**: gather data across systems → apply exemptions and document the basis → prepare response (fulfill, or explain the legal basis for partial/full denial) → inform the requester of their right to complain to the supervisory authority → document and retain records.

### Regulatory Monitoring

Monitor: regulatory guidance updates (ICO, CNIL, FTC, state AGs); enforcement actions signaling priorities; legislative changes; industry standards (ISO 27001, SOC 2, NIST); cross-border transfer developments (adequacy decisions, SCC updates, localization requirements).

Approach: subscribe to authority communications; track legal publications; review industry association updates; maintain a regulatory calendar of deadlines/effective dates; brief the legal team on material developments.

**Escalate to senior counsel/leadership when**: a new regulation/guidance directly affects core business activities; a sector enforcement action signals heightened scrutiny; a compliance deadline approaches requiring organizational change; a relied-upon transfer mechanism is challenged/invalidated; a regulator opens an inquiry/investigation involving the organization.

## Legal Risk Assessment

### Severity x Likelihood Framework

**Severity**:

| Level | Label | Description |
|---|---|---|
| 1 | Negligible | Minor inconvenience; no material impact; handled within normal operations |
| 2 | Low | Limited impact; minor financial exposure (<1% of relevant value); minor disruption; no public attention |
| 3 | Moderate | Meaningful impact; 1-5% financial exposure; noticeable disruption; potential limited public attention |
| 4 | High | Significant impact; 5-25% financial exposure; significant disruption; likely public attention; potential regulatory scrutiny |
| 5 | Critical | Severe impact; >25% financial exposure; fundamental business disruption; reputational damage; likely regulatory action; potential personal liability for officers/directors |

**Likelihood**:

| Level | Label | Description |
|---|---|---|
| 1 | Remote | Highly unlikely; no known precedent; would require exceptional circumstances |
| 2 | Unlikely | Could occur but not expected; limited precedent |
| 3 | Possible | May occur; some precedent; foreseeable triggering events |
| 4 | Likely | Probably will occur; clear precedent; common triggering events |
| 5 | Almost Certain | Expected to occur; strong precedent; triggering events present or imminent |

**Risk Score = Severity x Likelihood**

| Score | Risk Level | Color |
|---|---|---|
| 1-4 | Low | GREEN |
| 5-9 | Medium | YELLOW |
| 10-15 | High | ORANGE |
| 16-25 | Critical | RED |

```
                    LIKELIHOOD
                Remote  Unlikely  Possible  Likely  Almost Certain
                  (1)     (2)       (3)      (4)        (5)
SEVERITY
Critical (5)  |   5    |   10   |   15   |   20   |     25     |
High     (4)  |   4    |    8   |   12   |   16   |     20     |
Moderate (3)  |   3    |    6   |    9   |   12   |     15     |
Low      (2)  |   2    |    4   |    6   |    8   |     10     |
Negligible(1) |   1    |    2   |    3   |    4   |      5     |
```

### Risk Classification and Actions

**GREEN — Low (1-4)**: minor, unlikely-to-materialize issues within normal operating parameters, established mitigations. *Action*: accept, document in the risk register, monitor in periodic (quarterly/annual) reviews, no escalation. *Examples*: minor deviation from standard contract terms in a non-critical area; routine NDA with a known counterparty in a standard jurisdiction; minor admin compliance task with a clear owner/deadline.

**YELLOW — Medium (5-9)**: could materialize under foreseeable circumstances, warrants attention but not immediate action. *Action*: mitigate (specific controls or negotiation), monitor actively (monthly or trigger-based), document thoroughly, assign an owner, brief stakeholders, define escalation triggers. *Examples*: liability cap below standard but negotiable; vendor processing personal data without a clear adequacy determination; medium-term regulatory development; broader-than-preferred but market-common IP provision.

**ORANGE — High (10-15)**: meaningful probability, potential for substantial impact, requires senior attention. *Action*: escalate to senior counsel, develop a specific mitigation plan, brief leadership, weekly (or milestone-based) review, consider outside counsel, document in full risk-memo detail, define a contingency plan. *Examples*: uncapped indemnification in a material area; data processing that may violate a regulatory requirement absent restructuring; threatened litigation from a significant counterparty; colorable IP infringement allegation; regulatory inquiry/audit request.

**RED — Critical (16-25)**: likely/certain to materialize, could fundamentally impact the business. *Action*: immediate escalation to GC/C-suite/Board as appropriate, engage specialized outside counsel immediately, establish a dedicated response team, notify insurers if applicable, activate crisis management if reputational, preserve evidence/litigation hold, daily-or-more review, board reporting, make required regulatory notifications. *Examples*: active litigation with significant exposure; data breach affecting regulated personal data; regulatory enforcement action; material contract breach by/against the organization; government investigation; credible IP infringement claim against a core product.

### Risk Assessment Memo Format

```
## Legal Risk Assessment

**Date**: [assessment date]
**Assessor**: [person conducting assessment]
**Matter**: [description of the matter being assessed]
**Privileged**: [Yes/No]

### 1. Risk Description
### 2. Background and Context
### 3. Risk Analysis
#### Severity Assessment: [1-5] - [Label]  (rationale: financial, operational, reputational)
#### Likelihood Assessment: [1-5] - [Label]  (rationale: precedent, triggers, current conditions)
#### Risk Score: [Score] - [GREEN/YELLOW/ORANGE/RED]
### 4. Contributing Factors
### 5. Mitigating Factors
### 6. Mitigation Options
| Option | Effectiveness | Cost/Effort | Recommended? |
### 7. Recommended Approach
### 8. Residual Risk
### 9. Monitoring Plan
### 10. Next Steps
1. [Action item - Owner - Deadline]
```

### Risk Register Entry

| Field | Content |
|---|---|
| Risk ID | Unique identifier |
| Date Identified | When first identified |
| Description | Brief description |
| Category | Contract, Regulatory, Litigation, IP, Data Privacy, Employment, Corporate, Other |
| Severity / Likelihood / Risk Score / Risk Level | Per framework above |
| Owner | Person responsible for monitoring |
| Mitigations | Current controls in place |
| Status | Open / Mitigated / Accepted / Closed |
| Review Date | Next scheduled review |
| Notes | Additional context |

### When to Engage Outside Counsel

**Mandatory**: active litigation (filed against or by the org); government investigation/inquiry; potential criminal exposure; matters affecting securities disclosures/filings; board-level matters.

**Strongly recommended**: novel legal issues / questions of first impression; unfamiliar or conflicting jurisdictions; exposure exceeding risk tolerance thresholds; specialized expertise not available in-house (antitrust, FCPA, patent prosecution); material regulatory changes requiring compliance program development; M&A due diligence, structuring, and regulatory approvals.

**Consider**: complex contract disputes with material counterparties; employment claims (discrimination, harassment, wrongful termination, whistleblower); potential data breaches triggering notification obligations; IP infringement allegations involving material products; insurance coverage disputes.

**Selecting counsel**: relevant subject-matter expertise; jurisdictional experience; industry familiarity; conflict clearance; budget/fee arrangement; diversity considerations; existing panel relationships.

## Meeting Briefings

### Prep Methodology

1. **Identify the meeting**: title/type (deal review, board, vendor call, team sync, client meeting, regulatory discussion), participants and their roles/interests, agenda, the user's role (advisor/presenter/observer/negotiator), and available prep time.
2. **Assess prep needs by meeting type**:

| Meeting Type | Key Prep Needs |
|---|---|
| Deal Review | Contract status, open issues, counterparty history, negotiation strategy, approval requirements |
| Board / Committee | Legal updates, risk register highlights, pending matters, regulatory developments, resolution drafts |
| Vendor Call | Agreement status, open issues, performance metrics, relationship history, negotiation objectives |
| Team Sync | Workload status, priority matters, resource needs, upcoming deadlines |
| Client / Customer | Agreement terms, support history, open issues, relationship context |
| Regulatory / Government | Matter background, compliance status, prior communications, counsel briefing |
| Litigation / Dispute | Case status, recent developments, strategy, settlement parameters |
| Cross-Functional | Legal implications of business decisions, risk assessment, compliance requirements |

3. **Gather context from connected sources**: Calendar (meeting details, prior meetings with same attendees in last 3 months, related follow-ups, competing commitments); Email (recent correspondence, prior follow-up threads, open action items, shared documents); Chat (recent discussions, messages from/about participants, relevant decisions); Documents (agendas, prior notes, agreements/memos, draft materials); CLM (relevant contracts, status, approval workflow, amendment/renewal history); CRM (account/opportunity info, relationship history, deal stage, stakeholder map).
4. **Synthesize into the briefing template** (below).
5. **Identify prep gaps**: unavailable sources, outdated info, unanswered questions, documents that couldn't be located.

### Briefing Template

```
## Meeting Brief

### Meeting Details
- Meeting / Date-Time / Duration / Location / Your Role

### Participants
| Name | Organization | Role | Key Interests | Notes |

### Agenda / Expected Topics
1. [Topic] - [brief context]

### Background and Context
[2-3 paragraph summary: relevant history, current state, why this meeting is happening]

### Key Documents
- [Document] - [description and location]

### Open Issues
| Issue | Status | Owner | Priority | Notes |

### Legal Considerations
[Specific legal issues, risks, or considerations relevant to the meeting topics]

### Talking Points
1. [Key point, with supporting context]

### Questions to Raise
- [Question] - [why this matters]

### Decisions Needed
- [Decision] - [options and recommendation]

### Red Lines / Non-Negotiables
[If a negotiation meeting: positions that cannot be conceded]

### Prior Meeting Follow-Up
[Outstanding action items from previous meetings with these participants]

### Preparation Gaps
[Info that could not be found or verified; questions for the user]
```

### Meeting-Type Additions

- **Deal Review**: deal summary (parties, value, structure, timeline); contract status in review/negotiation with outstanding issues; approval requirements; counterparty dynamics (likely positions, recent communications, relationship temperature); comparable deals.
- **Board/Committee**: legal department update (matters, wins, new/closed matters); risk highlights from the risk register with changes since last report; regulatory update; pending resolutions/approvals; litigation summary (active matters, reserves, settlements, new filings).
- **Regulatory**: which regulator/division and current enforcement priorities; matter history (prior interactions, submissions, correspondence timeline); current compliance posture; outside counsel coordination and prior advice; privilege considerations (what can/cannot be discussed).

### Action Item Tracking

```
## Action Items from [Meeting Name] - [Date]

| # | Action Item | Owner | Deadline | Priority | Status |
```

Best practices: be specific ("send redline of Section 4.2 to counterparty counsel," not "follow up on contract"); every item has exactly one owner; every item has a specific deadline; note dependencies; distinguish legal-team / business-team / external / follow-up-meeting actions.

Follow-up: distribute action items to participants; set calendar reminders; update CLM/matter management/risk register with outcomes; file meeting notes; flag urgent items. Tracking cadence: high priority = daily; medium = next sync or weekly; low = next scheduled meeting or monthly; overdue = escalate to owner and their manager, flag in the next relevant meeting.

## Canned & Templated Responses

### Template Management

Each template needs: category, template name, use case, escalation triggers (when NOT to use it), required variables, template body, follow-up actions, last-reviewed date.

Lifecycle: create (based on best practices/team input) → review/approve → publish to the template library → use → track modifications-during-use as a signal for improvement → update when law/policy changes → retire when no longer applicable.

### Response Categories

**1. Data Subject Requests (DSRs)** — sub-categories: acknowledgment, identity verification, fulfillment (access/deletion/correction), partial denial, full denial, extension notice. Key elements: applicable regulation reference, response timeline, verification requirements, data subject rights (incl. right to complain to the supervisory authority), follow-up contact.
```
Subject: Your Data [Access/Deletion/Correction] Request - Reference {{request_id}}

Dear {{requester_name}},

We have received your request dated {{request_date}} to [access/delete/correct] your
personal data under [applicable regulation].

[Acknowledgment / verification request / fulfillment details / denial basis]

We will respond substantively by {{response_deadline}}.

[Contact information] [Rights information]
```

**2. Discovery / Litigation Holds** — sub-categories: initial notice, reminder/reaffirmation, scope modification, release. Key elements: matter name/reference, clear preservation obligations, scope (date range, data types, systems, communication types), anti-spoliation warning, contact, acknowledgment requirement.
```
Subject: LEGAL HOLD NOTICE - {{matter_name}} - Action Required
PRIVILEGED AND CONFIDENTIAL / ATTORNEY-CLIENT COMMUNICATION

Dear {{custodian_name}},

You may possess documents, communications, or data relevant to the matter above.

PRESERVATION OBLIGATION: Effective immediately, preserve all documents and ESI related to:
- Subject matter: {{hold_scope}}
- Date range: {{start_date}} to present
- Document types: {{document_types}}

DO NOT delete, destroy, modify, or discard potentially relevant materials.
[System/email/chat/local-file instructions]

Acknowledge receipt by {{acknowledgment_deadline}}. Contact {{legal_contact}} with questions.
```

**3. Privacy Inquiries** — cookie/tracking, privacy policy questions, data sharing practices, children's data, cross-border transfer questions. Key elements: reference to the org's privacy notice, answers based on current practices, links to documentation, privacy team contact.

**4. Vendor Legal Questions** — contract status, amendment requests, compliance certifications, audit requests, insurance certificates. Key elements: reference to the applicable agreement, specific response, caveats/limitations, next steps/timeline.

**5. NDA Requests** — sending the standard form, accepting a counterparty's NDA with markup, declining with explanation, renewal/extension. Key elements: purpose, standard terms summary, execution instructions, timeline.

**6. Subpoena / Legal Process** — acknowledgment, objection letter, extension request, compliance cover letter. Key elements: case reference/jurisdiction, specific objections, preservation confirmation, compliance timeline, privilege log reference. **Always requires individualized counsel review — templates are starting frameworks only, never final responses.**

**7. Insurance Notifications** — initial claim notice, supplemental info, reservation-of-rights response. Key elements: policy number/coverage period, matter/incident description, timeline of events, requested coverage confirmation.

### Customization Guidelines

Every response must be customized with: correct names/dates/reference numbers; the specific facts; applicable jurisdiction/regulation; correct deadline based on when the inquiry was received; appropriate signature block.

Adjust tone for: audience (internal/external, business/legal, individual/regulator); relationship (new counterparty/existing partner/adversarial); sensitivity (routine/contentious/investigation); urgency.

Jurisdiction adjustments: verify cited regulations match the requester's jurisdiction; adjust timelines to applicable law; include jurisdiction-specific rights info; use jurisdiction-appropriate terminology.

### Escalation Trigger Identification

Check before generating any response.

**Universal triggers**: potential litigation or regulatory investigation; inquiry from a regulator/government/law enforcement; response could create a binding commitment or waiver; potential criminal liability; media attention involved or likely; unprecedented situation; multiple jurisdictions with conflicting requirements; involves executive leadership or board members.

**Category-specific**:
- *DSRs*: request from/on behalf of a minor; data subject to a litigation hold; requester in active litigation/dispute with the org; requester is an employee with an active HR matter; scope suggests a fishing expedition; involves special category data (health, biometric, genetic).
- *Discovery holds*: potential criminal liability; unclear/disputed preservation scope; conflicts with regulatory deletion requirements; prior holds exist for related matters; custodian objects to scope.
- *Vendor questions*: vendor disputing contract terms; vendor threatening litigation/termination; response could affect an ongoing negotiation; involves regulatory compliance, not just contract interpretation.
- *Subpoena/legal process*: always requires counsel review; privilege issues; third-party data involved; cross-border production issues; unreasonable timeline.

**When a trigger is detected**: stop generating the templated response → alert the user → explain which trigger and why it matters → recommend the escalation path (senior counsel, outside counsel, specific team member) → optionally offer a draft clearly marked "DRAFT - FOR COUNSEL REVIEW ONLY".

### Creating a New Template

1. Define the use case (inquiry type, frequency, audience, urgency).
2. Identify required elements (mandatory info, regulatory requirements, org policies).
3. Define variables — what changes each use (`{{requester_name}}`, `{{response_deadline}}`, `{{matter_reference}}`) vs. what stays fixed.
4. Draft in clear, professional language; avoid unneeded jargon for business audiences; include all legally required elements; add a subject-line template for email use.
5. Define escalation triggers — specific, not vague.
6. Add metadata: name/category, version, last-reviewed date, author/approver, follow-up actions checklist.

```markdown
## Template: {{template_name}}
**Category**: {{category}}
**Version**: {{version}} | **Last Reviewed**: {{date}}
**Approved By**: {{approver}}

### Use When
- [Condition 1]

### Do NOT Use When (Escalation Triggers)
- [Trigger 1]

### Variables
| Variable | Description | Example |

### Subject Line
[Subject template with {{variables}}]

### Body
[Response body with {{variables}}]

### Follow-Up Actions
1. [Action 1]

### Notes
[Any special instructions]
```
