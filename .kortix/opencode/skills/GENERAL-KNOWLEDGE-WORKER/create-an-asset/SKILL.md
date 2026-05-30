---
name: create-an-asset
description: "Use for building prospect-specific sales assets such as landing pages, decks, one-pagers, and workflow demos."
---

# Create an Asset

> **Visual design for web-based formats:** When building interactive landing pages or any HTML/web-based sales asset, do NOT follow the visual design guidance (Phase 4) in this skill. Instead, read and follow `skills/GENERAL-KNOWLEDGE-WORKER/website-building/SKILL.md` for all design tokens, typography, color systems, layout, and CSS. This skill's Phase 4 applies only to non-web outputs (decks, one-pagers). The sales content structure, research, and methodology in this skill still applies to all formats.

Generate custom sales assets tailored to your prospect, audience, and goals. Supports interactive landing pages, presentation decks, executive one-pagers, and workflow/architecture demos.

---

## Triggers

Invoke this skill when:
- User says `/create-an-asset` or `/create-an-asset [CompanyName]`
- User asks to "create an asset", "build a demo", "make a landing page", "mock up a workflow"
- User needs a customer-facing deliverable for a sales conversation

---

## Overview

This skill creates professional sales assets by gathering context about:
- **(a) The Prospect** — company, contacts, conversations, pain points
- **(b) The Audience** — who's viewing, what they care about
- **(c) The Purpose** — goal of the asset, desired next action
- **(d) The Format** — landing page, deck, one-pager, or workflow demo

The skill then researches, structures, and builds a polished, branded asset ready to share with customers.

---

## Phase 0: Context Detection & Input Collection

### Step 0.1: Detect Seller Context

From the user's email domain, identify what company they work for.

**Actions:**
1. Extract domain from user's email
2. Search: `"[domain]" company products services site:linkedin.com OR site:crunchbase.com`
3. Determine seller context:

| Scenario | Action |
|----------|--------|
| **Single-product company** | Auto-populate seller context |
| **Multi-product company** | Ask: "Which product or solution is this asset for?" |
| **Consultant/agency/generic domain** | Ask: "What company or product are you representing?" |
| **Unknown/startup** | Ask: "Briefly, what are you selling?" |

**Store seller context:**
```yaml
seller:
  company: "[Company Name]"
  product: "[Product/Service]"
  value_props:
    - "[Key value prop 1]"
    - "[Key value prop 2]"
    - "[Key value prop 3]"
  differentiators:
    - "[Differentiator 1]"
    - "[Differentiator 2]"
  pricing_model: "[If publicly known]"
```

**Persist to knowledge base** for future sessions. On subsequent invocations, confirm: "I have your seller context from last time — still selling [Product] at [Company]?"

---

### Step 0.2: Collect Prospect Context (a)

**Ask the user:**

| Field | Prompt | Required |
|-------|--------|----------|
| **Company** | "Which company is this asset for?" | ✓ Yes |
| **Key contacts** | "Who are the key contacts? (names, roles)" | No |
| **Deal stage** | "What stage is this deal?" | ✓ Yes |
| **Pain points** | "What pain points or priorities have they shared?" | No |
| **Past materials** | "Upload any conversation materials (transcripts, emails, notes, call recordings)" | No |

**Deal stage options:**
- Intro / First meeting
- Discovery
- Evaluation / Technical review
- POC / Pilot
- Negotiation
- Close

---

### Step 0.3: Collect Audience Context (b)

**Ask the user:**

| Field | Prompt | Required |
|-------|--------|----------|
| **Audience type** | "Who's viewing this?" | ✓ Yes |
| **Specific roles** | "Any specific titles to tailor for? (e.g., CTO, VP Engineering, CFO)" | No |
| **Primary concern** | "What do they care most about?" | ✓ Yes |
| **Objections** | "Any concerns or objections to address?" | No |

**Audience type options:**
- Executive (C-suite, VPs)
- Technical (Architects, Engineers, Developers)
- Operations (Ops, IT, Procurement)
- Mixed / Cross-functional

**Primary concern options:**
- ROI / Business impact
- Technical depth / Architecture
- Strategic alignment
- Risk mitigation / Security
- Implementation / Timeline

---

### Step 0.4: Collect Purpose Context (c)

**Ask the user:**

| Field | Prompt | Required |
|-------|--------|----------|
| **Goal** | "What's the goal of this asset?" | ✓ Yes |
| **Desired action** | "What should the viewer do after seeing this?" | ✓ Yes |

**Goal options:**
- Intro / First impression
- Discovery follow-up
- Technical deep-dive
- Executive alignment / Business case
- POC proposal
- Deal close

---

### Step 0.5: Select Format (d)

**Ask the user:** "What format works best for this?"

| Format | Description | Best For |
|--------|-------------|----------|
| **Interactive landing page** | Multi-tab page with demos, metrics, calculators | Exec alignment, intros, value prop |
| **Deck-style** | Linear slides, presentation-ready | Formal meetings, large audiences |
| **One-pager** | Single-scroll executive summary | Leave-behinds, quick summaries |
| **Workflow / Architecture demo** | Interactive diagram with animated flow | Technical deep-dives, POC demos, integrations |

> **Note:** For interactive landing pages and other web-based formats, use the `website-building` family of skills for all visual design and styling. This skill's Phase 4 visual design applies only to non-web outputs.

---

### Step 0.6: Format-Specific Inputs

#### If "Workflow / Architecture demo" selected:

**First, parse from user's description.** Look for:
- Systems and components mentioned
- Data flows described
- Human interaction points
- Example scenarios

**Then ask for any gaps:**

| If Missing... | Ask... |
|---------------|--------|
| Components unclear | "What systems or components are involved? (databases, APIs, AI, middleware, etc.)" |
| Flow unclear | "Walk me through the step-by-step flow" |
| Human touchpoints unclear | "Where does a human interact in this workflow?" |
| Scenario vague | "What's a concrete example scenario to demo?" |
| Integration specifics | "Any specific tools or platforms to highlight?" |

---

## Phase 1: Research (Adaptive)

### Assess Context Richness

| Level | Indicators | Research Depth |
|-------|------------|----------------|
| **Rich** | Transcripts uploaded, detailed pain points, clear requirements | Light — fill gaps only |
| **Moderate** | Some context, no transcripts | Medium — company + industry |
| **Sparse** | Just company name | Deep — full research pass |

### Always Research:

1. **Prospect basics**
   - Search: `"[Company]" annual report investor presentation 2025 2026`
   - Search: `"[Company]" CEO strategy priorities 2025 2026`
   - Extract: Revenue, employees, key metrics, strategic priorities

2. **Leadership**
   - Search: `"[Company]" CEO CTO CIO 2025`
   - Extract: Names, titles, recent quotes on strategy/technology

3. **Brand colors**
   - Search: `"[Company]" brand guidelines`
   - Or extract from company website
   - Store: Primary color, secondary color, accent

### If Moderate/Sparse Context, Also Research:

4. **Industry context**
   - Search: `"[Industry]" trends challenges 2025 2026`
   - Extract: Common pain points, market dynamics

5. **Technology landscape**
   - Search: `"[Company]" technology stack tools platforms`
   - Extract: Current solutions, potential integration points

6. **Competitive context**
   - Search: `"[Company]" vs [seller's competitors]`
   - Extract: Current solutions, switching signals

### If Transcripts/Materials Uploaded:

7. **Conversation analysis**
   - Extract: Stated pain points, decision criteria, objections, timeline
   - Identify: Key quotes to reference (use their exact language)
   - Note: Specific terminology, acronyms, internal project names

---

## Phase 2: Structure Decision

### Interactive Landing Page

| Purpose | Recommended Sections |
|---------|---------------------|
| **Intro** | Company Fit → Solution Overview → Key Use Cases → Why Us → Next Steps |
| **Discovery follow-up** | Their Priorities → How We Help → Relevant Examples → ROI Framework → Next Steps |
| **Technical deep-dive** | Architecture → Security & Compliance → Integration → Performance → Support |
| **Exec alignment** | Strategic Fit → Business Impact → ROI Calculator → Risk Mitigation → Partnership |
| **POC proposal** | Scope → Success Criteria → Timeline → Team → Investment → Next Steps |
| **Deal close** | Value Summary → Pricing → Implementation Plan → Terms → Sign-off |

**Audience adjustments:**
- **Executive**: Lead with business impact, ROI, strategic alignment
- **Technical**: Lead with architecture, security, integration depth
- **Operations**: Lead with workflow impact, change management, support
- **Mixed**: Balance strategic + tactical; use tabs to separate depth levels

---

### Deck-Style

Same sections as landing page, formatted as linear slides:

```
1. Title slide (Prospect + Seller logos, partnership framing)
2. Agenda
3-N. One section per slide (or 2-3 slides for dense sections)
N+1. Summary / Key takeaways
N+2. Next steps / CTA
N+3. Appendix (optional — detailed specs, pricing, etc.)
```

**Slide principles:**
- One key message per slide
- Visual > text-heavy
- Use prospect's metrics and language
- Include speaker notes

---

### One-Pager

Condense to single-scroll format:

```
┌─────────────────────────────────────┐
│ HERO: "[Prospect Goal] with [Product]" │
├─────────────────────────────────────┤
│ KEY POINT 1     │ KEY POINT 2     │ KEY POINT 3     │
│ [Icon + 2-3     │ [Icon + 2-3     │ [Icon + 2-3     │
│  sentences]     │  sentences]     │  sentences]     │
├─────────────────────────────────────┤
│ PROOF POINT: [Metric, quote, or case study] │
├─────────────────────────────────────┤
│ CTA: [Clear next action] │ [Contact info] │
└─────────────────────────────────────┘
```

---

### Workflow / Architecture Demo

**Structure based on complexity:**

| Complexity | Components | Structure |
|------------|------------|-----------|
| **Simple** | 3-5 | Single-view diagram with step annotations |
| **Medium** | 5-10 | Zoomable canvas with step-by-step walkthrough |
| **Complex** | 10+ | Multi-layer view (overview → detailed) with guided tour |

**Standard elements:**

1. **Title bar**: `[Scenario Name] — Powered by [Seller Product]`
2. **Component nodes**: Visual boxes/icons for each system
3. **Flow arrows**: Animated connections showing data movement
4. **Step panel**: Sidebar explaining current step in plain language
5. **Controls**: Play / Pause / Step Forward / Step Back / Reset
6. **Annotations**: Callouts for key decision points and value-adds
7. **Data preview**: Sample payloads or transformations at each step

---

## Phase 3: Content Generation

### General Principles

All content should:
- Reference **specific pain points** from user input or transcripts
- Use **prospect's language** — their terminology, their stated priorities
- Map **seller's product** → **prospect's needs** explicitly
- Include **proof points** where available (case studies, metrics, quotes)
- Feel **tailored, not templated**

---

### Section Templates

#### Hero / Intro
```
Headline: "[Prospect's Goal] with [Seller's Product]"
Subhead: Tie to their stated priority or top industry challenge
Metrics: 3-4 key facts about the prospect (shows we did homework)
```

#### Their Priorities (if discovery follow-up)
```
Reference specific pain points from conversation:
- Use their exact words where possible
- Show we listened and understood
- Connect each to how we help
```

#### Solution Mapping
```
For each pain point:
├── The challenge (in their words)
├── How [Product] addresses it
├── Proof point or example
└── Outcome / benefit
```

#### Use Cases / Demos
```
3-5 relevant use cases:
├── Visual mockup or interactive demo
├── Business impact (quantified if possible)
├── "How it works" — 3-4 step summary
└── Relevant to their industry/role
```

#### ROI / Business Case
```
Interactive calculator with:
├── Inputs relevant to their business (from research)
│   ├── Number of users/developers
│   ├── Current costs or time spent
│   └── Expected improvement %
├── Outputs:
│   ├── Annual value / savings
│   ├── Cost of solution
│   ├── Net ROI
│   └── Payback period
└── Assumptions clearly stated (editable)
```

#### Why Us / Differentiators
```
├── Differentiators vs. alternatives they might consider
├── Trust, security, compliance positioning
├── Support and partnership model
└── Customer proof points (logos, quotes, case studies)
```

#### Next Steps / CTA
```
├── Clear action aligned to Purpose (c)
├── Specific next step (not vague "let's chat")
├── Contact information
├── Suggested timeline
└── What happens after they take action
```

---

### Workflow Demo Content

#### Component Definitions

For each system, define:

```yaml
component:
  id: "snowflake"
  label: "Snowflake Data Warehouse"
  type: "database"  # database | api | ai | middleware | human | document | output
  icon: "database"
  description: "Financial performance data"
  brand_color: "#29B5E8"
```

**Component types:**
- `human` — Person initiating or receiving
- `document` — PDFs, contracts, files
- `ai` — AI/ML models, agents
- `database` — Data stores, warehouses
- `api` — APIs, services
- `middleware` — Integration platforms, MCP servers
- `output` — Dashboards, reports, notifications

#### Flow Steps

For each step, define:

```yaml
step:
  number: 1
  from: "human"
  to: "claude"
  action: "Initiates performance review"
  description: "Sarah, a Brand Analyst at [Prospect], kicks off the quarterly review..."
  data_example: "Review request: Nike brand, Q4 2025"
  duration: "~1 second"
  value_note: "No manual data gathering required"
```

#### Scenario Narrative

Write a clear, specific walkthrough:

```
Step 1: Human Trigger
"Sarah, a Brand Performance Analyst at Centric Brands, needs to review
Q4 performance for the Nike license agreement. She opens the review
dashboard and clicks 'Start Review'..."

Step 2: Contract Analysis
"Kortix retrieves the Nike contract PDF and extracts the performance
obligations: minimum $50M revenue, 12% margin requirement, quarterly
reporting deadline..."

Step 3: Data Query
"Kortix formulates a query and sends it to Workato DataGenie:
'Get Q4 2025 revenue and gross margin for Nike brand from Snowflake'..."

Step 4: Results & Synthesis
"Snowflake returns the data. Kortix compares actuals vs. obligations:
Revenue $52.3M ✓ (exceeded by $2.3M)
Margin 11.2% ⚠️ (0.8% below threshold)..."

Step 5: Insight Delivery
"Kortix synthesizes findings into an executive summary with
recommendations: 'Review promotional spend allocation to improve
margin performance...'"
```

---

## Phase 4: Visual Design

> **Non-web formats only.** The color system, typography, cards, buttons, and animations below apply to deck-style, one-pager, and workflow demo outputs. For interactive landing pages and any web-based format, ignore this section entirely and follow the `website-building` skill for visual design.

**Design foundation:** Follow the design-foundations principle of **1 accent + neutrals** (see `skills/GENERAL-KNOWLEDGE-WORKER/design-foundations/SKILL.md`). The prospect's brand primary becomes the accent; everything else should be neutral. If no brand colors are available, fall back to the Kortix neutral palette defaults: black/white or off-white neutrals plus one accent. Reserve color for emphasis — the viewer's eye goes where color is.

### Color System

```css
:root {
    /* === Prospect Brand (Primary) === */
    --brand-primary: #[extracted from research];
    --brand-secondary: #[extracted];
    --brand-primary-rgb: [r, g, b]; /* For rgba() usage */

    /* === Dark Theme Base === */
    --bg-primary: #0a0d14;
    --bg-elevated: #0f131c;
    --bg-surface: #161b28;
    --bg-hover: #1e2536;

    /* === Text === */
    --text-primary: #ffffff;
    --text-secondary: rgba(255, 255, 255, 0.7);
    --text-muted: rgba(255, 255, 255, 0.5);

    /* === Accent === */
    --accent: var(--brand-primary);
    --accent-hover: var(--brand-secondary);
    --accent-glow: rgba(var(--brand-primary-rgb), 0.3);

    /* === Status === */
    --success: #10b981;
    --warning: #f59e0b;
    --error: #ef4444;
}
```

### Typography

```css
/* Primary: Clean, professional sans-serif */
font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;

/* Headings */
h1: 2.5rem, font-weight: 700
h2: 1.75rem, font-weight: 600
h3: 1.25rem, font-weight: 600

/* Body */
body: 1rem, font-weight: 400, line-height: 1.6

/* Captions/Labels */
small: 0.875rem, font-weight: 500
```

### Visual Elements

**Cards:**
- Background: `var(--bg-surface)`
- Border: 1px solid rgba(255,255,255,0.1)
- Border-radius: 12px
- Box-shadow: subtle, layered
- Hover: slight elevation, border glow

**Buttons:**
- Primary: `var(--accent)` background, white text
- Secondary: transparent, accent border
- Hover: brightness increase, subtle scale

**Animations:**
- Transitions: 200-300ms ease
- Tab switches: fade + slide
- Hover states: smooth, not jarring
- Loading: subtle pulse or skeleton

### Workflow Demo Specific

**Component Nodes:**
```css
.node {
    background: var(--bg-surface);
    border: 2px solid var(--brand-primary);
    border-radius: 12px;
    padding: 16px;
    min-width: 140px;
}

.node.active {
    box-shadow: 0 0 20px var(--accent-glow);
    border-color: var(--accent);
}

.node.human {
    border-color: #f59e0b; /* Warm color for humans */
}

.node.ai {
    background: linear-gradient(135deg, var(--bg-surface), var(--bg-elevated));
    border-color: var(--accent);
}
```

**Flow Arrows:**
```css
.arrow {
    stroke: var(--text-muted);
    stroke-width: 2;
    fill: none;
    marker-end: url(#arrowhead);
}

.arrow.active {
    stroke: var(--accent);
    stroke-dasharray: 8 4;
    animation: flowDash 1s linear infinite;
}
```

**Canvas:**
```css
.canvas {
    background:
        radial-gradient(circle at center, var(--bg-elevated) 0%, var(--bg-primary) 100%),
        url("data:image/svg+xml,..."); /* Subtle grid pattern */
    overflow: auto;
}
```

---

## Phase 5: Clarifying Questions (REQUIRED)

**Before building any asset, always ask clarifying questions.** This ensures alignment and prevents wasted effort.

### Step 5.1: Summarize Understanding

First, show the user what you understood:

```
"Here's what I'm planning to build:

**Asset**: [Format] for [Prospect Company]
**Audience**: [Audience type] — specifically [roles if known]
**Goal**: [Purpose] → driving toward [desired action]
**Key themes**: [2-3 main points to emphasize]

[For workflow demos, also show:]
**Components**: [List of systems]
**Flow**: [Step 1] → [Step 2] → [Step 3] → ...
```

### Step 5.2: Ask Standard Questions (ALL formats)

| Question | Why |
|----------|-----|
| "Does this match your vision?" | Confirm understanding |
| "What's the ONE thing this must nail to succeed?" | Focus on priority |
| "Tone preference? (Bold & confident / Consultative / Technical & precise)" | Style alignment |
| "Focused and concise, or comprehensive?" | Scope calibration |

### Step 5.3: Ask Format-Specific Questions

#### Interactive Landing Page:
- "Which sections matter most for this audience?"
- "Any specific demos or use cases to highlight?"
- "Should I include an ROI calculator?"
- "Any competitor positioning to address?"

#### Deck-Style:
- "How long is the presentation? (helps with slide count)"
- "Presenting live, or a leave-behind?"
- "Any specific flow or narrative arc in mind?"

#### One-Pager:
- "What's the single most important message?"
- "Any specific proof point or stat to feature?"
- "Will this be printed or digital?"

#### Workflow / Architecture Demo:
- "Let me confirm the components: [list]. Anything missing?"
- "Here's the flow I understood: [steps]. Correct?"
- "Should the demo show realistic sample data, or keep it abstract?"
- "Any integration details to highlight or downplay?"
- "Should viewers be able to click through steps, or auto-play?"

### Step 5.4: Confirm and Proceed

After user responds:

```
"Got it. I have what I need. Building your [format] now..."
```

Or, if still unclear:

```
"One more quick question: [specific follow-up]"
```

**Max 2 rounds of questions.** If still ambiguous, make a reasonable choice and note: "I went with X — easy to adjust if you prefer Y."

---

## Phase 6: Build & Deliver

### Build the Asset

Following all specifications above:
1. Generate structure based on Phase 2
2. Create content based on Phase 3
3. Apply visual design based on Phase 4
4. Ensure all interactive elements work
5. Test responsiveness (if applicable)

### Output Format

**All formats**: Self-contained HTML file
- All CSS inline or in `<style>` tags
- All JS inline or in `<script>` tags
- No external dependencies (except Google Fonts)
- Single file for easy sharing

**File naming**: `[ProspectName]-[format]-[date].html`
- Example: `CentricBrands-workflow-demo-2026-01-28.html`

### Delivery Message

```markdown
## ✓ Asset Created: [Prospect Name]

Deliver the generated file with `show`, or provide the verified local preview URL if the asset is being served locally.

---

**Summary**
- **Format**: [Interactive Page / Deck / One-Pager / Workflow Demo]
- **Audience**: [Type and roles]
- **Purpose**: [Goal] → [Desired action]
- **Sections/Steps**: [Count and list]

---

**Deployment Options**

To share this with your customer:
- **Static hosting**: Upload to Netlify, Vercel, GitHub Pages, AWS S3, or any static host
- **Password protection**: Most hosts offer this (e.g., Netlify site protection)
- **Direct share**: Send the HTML file directly — it's fully self-contained
- **Embed**: The file can be iframed into other pages if needed

---

**Customization**

Let me know if you'd like to:
- Adjust colors or styling
- Add, remove, or reorder sections
- Refine any messaging or copy
- Change the flow or architecture (for workflow demos)
- Add more interactive elements
- Export as PDF or static images
```

---

## Phase 7: Iteration Support

After delivery, be ready to iterate:

| User Request | Action |
|--------------|--------|
| "Change the colors" | Regenerate with new palette, keep content |
| "Add a section on X" | Insert new section, maintain flow |
| "Make it shorter" | Condense, prioritize key points |
| "The flow is wrong" | Rebuild architecture based on correction |
| "Use our brand instead" | Switch from prospect brand to seller brand |
| "Add more detail on step 3" | Expand that section specifically |
| "Can I get this as a PDF?" | Provide print-optimized version |

**Remember**: Default to prospect's brand colors, but seller can adjust to their own brand or a neutral palette after initial build.

---

## Quality Checklist

Before delivering, verify:

### Content
- [ ] Prospect company name spelled correctly throughout
- [ ] Leadership names are current (not outdated)
- [ ] Pain points accurately reflect input/transcripts
- [ ] Seller's product accurately represented
- [ ] No placeholder text remaining
- [ ] Proof points are accurate and sourced

### Visual
- [ ] Brand colors applied correctly
- [ ] All text readable (contrast)
- [ ] Animations smooth, not distracting
- [ ] Mobile responsive (if interactive page)
- [ ] Dark theme looks polished

### Functional
- [ ] All tabs/sections load correctly
- [ ] Interactive elements work (calculators, demos)
- [ ] Workflow steps animate properly (if applicable)
- [ ] Navigation is intuitive
- [ ] CTA is clear and clickable

### Professional
- [ ] Tone matches audience
- [ ] Appropriate level of detail for purpose
- [ ] No typos or grammatical errors
- [ ] Feels tailored, not templated

---

## Examples

### Example 1: Executive Landing Page

**Input:**
- Prospect: Acme Corp (manufacturing)
- Audience: C-suite
- Purpose: Exec alignment after discovery
- Format: Interactive landing page

**Output structure:**
```
[Tabs]
Strategic Fit | Business Impact | ROI Calculator | Security & Trust | Next Steps

[Strategic Fit tab]
- Acme's stated priorities (from discovery call)
- How [Product] aligns
- Relevant manufacturing customers
```

### Example 2: Technical Workflow Demo

**Input:**
- Prospect: Centric Brands
- Audience: IT architects
- Purpose: POC proposal
- Format: Workflow demo
- Components: Kortix, Workato DataGenie, Snowflake, PDF contracts

**Output structure:**
```
[Interactive canvas with 5 nodes]
Human → Kortix → PDF Contracts → Workato → Snowflake
         ↓
    [Results back to Human]

[Step-by-step walkthrough with sample data]
[Controls: Play | Pause | Step | Reset]
```

### Example 3: Sales One-Pager

**Input:**
- Prospect: TechStart Inc
- Audience: VP Engineering
- Purpose: Leave-behind after first meeting
- Format: One-pager

**Output structure:**
```
Hero: "Accelerate TechStart's Product Velocity"
Point 1: [Dev productivity]
Point 2: [Code quality]
Point 3: [Time to market]
Proof: "Similar companies saw 40% faster releases"
CTA: "Schedule technical deep-dive"
```

---

## Appendix: Component Icons

For workflow demos, use these icon mappings:

| Type | Icon | Example |
|------|------|---------|
| human | 👤 or person SVG | User, Analyst, Admin |
| document | 📄 or file SVG | PDF, Contract, Report |
| ai | 🤖 or brain SVG | Kortix, AI Agent |
| database | 🗄️ or cylinder SVG | Snowflake, Postgres |
| api | 🔌 or plug SVG | REST API, GraphQL |
| middleware | ⚡ or hub SVG | Workato, MCP Server |
| output | 📊 or screen SVG | Dashboard, Report |

---

## Appendix: Brand Color Fallbacks

If brand colors cannot be extracted, use **1 accent** from this table + neutrals (dark text on light surfaces). Do not use multiple accent colors — reserve color for emphasis.

| Industry | Accent |
|----------|--------|
| Technology | `#2563eb` (blue) |
| Finance | `#0f172a` (navy) |
| Healthcare | `#0891b2` (teal) |
| Manufacturing | `#ea580c` (orange) |
| Retail | `#db2777` (magenta) |
| Energy | `#16a34a` (green) |
| Default | Kortix teal `#22808D` (see `skills/GENERAL-KNOWLEDGE-WORKER/design-foundations/SKILL.md`) |

---

*Skill created for generalized sales asset generation. Works for any seller, any product, any prospect.*
