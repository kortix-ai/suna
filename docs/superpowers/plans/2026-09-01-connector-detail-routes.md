# Connector Detail Routes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace connector-card detail modals with fast routed pages that keep technical connection data readable and progressively disclose secondary configuration.

**Architecture:** The connector list emits typed route hrefs. Connected detail reads the existing `qk.project.connectors(projectId)` cache and composes the existing Accounts, Tools, and Settings sections without a modal. Catalogue detail resolves one source record, shows its technical setup and documentation, and loads the existing add flow only after the primary action.

**Tech Stack:** Next.js App Router, React 19, TypeScript, TanStack Query, Tailwind CSS, Kortix UI primitives, Bun tests.

**Spec:** `docs/superpowers/specs/2026-09-01-connector-detail-routes-design.md`

## Global Constraints

- Keep Global rules and its sheet unchanged.
- Do not copy the Paper sidebar.
- Keep technical labels such as OAuth, API key, MCP transport, endpoint, request header, and access scope.
- Do not fabricate official documentation URLs.
- Keep Connect, Reconnect, Add credential, Replace credential, and approval actions outside Advanced.
- Do not edit `packages/sdk` or change public SDK exports.
- Preserve existing connector mutation and query keys.
- Use semantic color tokens, Phosphor icons, and existing Kortix components.

---

### Task 1: Typed connector route helpers

**Files:**
- Create: `apps/web/src/features/workspace/capabilities/connectors/connector-routes.ts`
- Create: `apps/web/src/features/workspace/capabilities/connectors/connector-routes.test.ts`

**Interfaces:**
- Produces: `connectedConnectorHref(projectId: string, slug: string): string`
- Produces: `catalogConnectorHref(projectId: string, entry: Pick<CatalogEntry, 'source' | 'slug'>): string`
- Produces: `parseCatalogSource(value: string): CatalogEntry['source'] | null`

- [ ] Write tests that assert encoded project IDs and slugs, all three catalogue sources, and invalid source rejection.
- [ ] Run `cd apps/web && bun test src/features/workspace/capabilities/connectors/connector-routes.test.ts` and confirm failure because the module does not exist.
- [ ] Implement the three helpers with `encodeURIComponent` for individual path segments.
- [ ] Run the focused test and confirm all assertions pass.
- [ ] Commit with `feat(web): add connector detail route helpers`.

### Task 2: Reusable technical detail components

**Files:**
- Create: `apps/web/src/features/workspace/capabilities/connectors/detail/connector-detail-copy.ts`
- Create: `apps/web/src/features/workspace/capabilities/connectors/detail/connector-detail-copy.test.ts`
- Create: `apps/web/src/features/workspace/capabilities/connectors/detail/connector-detail-layout.tsx`
- Create: `apps/web/src/features/workspace/capabilities/connectors/detail/connector-advanced.tsx`

**Interfaces:**
- Produces: `connectorSetupSteps(input): ConnectorSetupStep[]` with exactly three concise steps.
- Produces: `connectorTechnicalRows(config): ConnectorTechnicalRow[]` with labels `Transport`, `Endpoint`, `Authentication`, `Credential location`, `Access`, and `Request headers` when values exist.
- Produces: `ConnectorDetailLayout`, `ConnectorSetupGuide`, `ConnectorDocumentationLinks`, and `ConnectorAdvanced`.

- [ ] Write tests for managed OAuth, direct API credential, MCP endpoint, no-auth, project access, user access, and omission of absent rows.
- [ ] Run the focused copy test and confirm failure because the helpers do not exist.
- [ ] Implement pure copy and row helpers. Keep technical terms and add one-sentence explanations.
- [ ] Implement the layout with a Back button, identity header, primary action slot, setup guide, documentation links, horizontal-scroll tabs slot, and collapsed `Disclosure` for Advanced.
- [ ] Use `Card`, `Badge`, `Button`, `Disclosure`, and semantic tokens. Use no raw palette colors.
- [ ] Run the focused tests and ESLint on the four files.
- [ ] Commit with `feat(web): add connector technical detail components`.

### Task 3: Connected connector route

**Files:**
- Create: `apps/web/src/app/(app)/projects/[id]/(capabilities)/connectors/[slug]/page.tsx`
- Create: `apps/web/src/features/workspace/capabilities/connectors/detail/connected-connector-page.tsx`
- Modify: `apps/web/src/features/workspace/capabilities/connectors/detail/connector-settings.tsx`
- Retire: `apps/web/src/features/workspace/capabilities/connectors/detail/connector-modal.tsx`

**Interfaces:**
- Consumes: `connectedConnectorHref`, `ConnectorDetailLayout`, `connectorSetupSteps`, and `connectorTechnicalRows`.
- Reuses: `ConnectorAccounts`, `ConnectorTools`, `ConnectorSettings`, `usePipedreamConnect`, and existing authorization query keys.

- [ ] Write a source-level route test that requires the `[slug]` page, the list query key, horizontal Accounts/Tools/Settings tabs, and absence of `ModalContent`.
- [ ] Run the test and confirm it fails because the route does not exist.
- [ ] Create the route page with `useParams`, `Suspense`, and a shape-matched capability skeleton.
- [ ] Build `ConnectedConnectorPage` from the current modal behavior. Select the connector from `qk.project.connectors(projectId)` and paint identity before secondary queries finish.
- [ ] Move OAuth result handling from the list page to this route. Preserve all non-OAuth query parameters.
- [ ] Query `getConnectorConfig(projectId, slug)` after identity resolves. Feed transport, endpoint, auth, access, and headers into Advanced.
- [ ] Keep the primary connection action above tabs. Dynamically load `SetCredentialModal` only when credential UI opens.
- [ ] Compose Accounts, Tools, and Settings under horizontal underline tabs. Keep removal confirmation behavior and return to the list after confirmed removal.
- [ ] Delete the retired modal after all imports are removed.
- [ ] Run focused connector detail, tab, account, tool, and settings tests.
- [ ] Commit with `feat(web): add routed connected connector detail`.

### Task 4: Catalogue connector route

**Files:**
- Create: `apps/web/src/app/(app)/projects/[id]/(capabilities)/connectors/catalog/[source]/[slug]/page.tsx`
- Create: `apps/web/src/features/workspace/capabilities/connectors/detail/catalog-connector-page.tsx`
- Create: `apps/web/src/features/workspace/capabilities/connectors/detail/catalog-connector-page.test.ts`
- Modify: `apps/web/src/features/workspace/capabilities/connectors/add/discover-add-flow.tsx`
- Modify: `apps/web/src/features/workspace/capabilities/connectors/add/easy-connect-add-flow.tsx`

**Interfaces:**
- Consumes: `parseCatalogSource`, `ConnectorDetailLayout`, and the existing add-flow components.
- Produces: catalogue resolution for `discover`, `easy-connect`, and `computer` sources.

- [ ] Write tests for source parsing, exact slug selection, discover variant documentation, managed auth labels, computer detail, and not-found states.
- [ ] Run the focused test and confirm failure because the page component does not exist.
- [ ] Resolve Discover with `listDiscoverConnectors(projectId, slug)` then `getDiscoverConnector(projectId, item.id)`.
- [ ] Resolve Easy Connect with `listPipedreamApps(projectId, slug)` and an exact folded slug/name match.
- [ ] Resolve Computer from `computersCatalogEntry()` without a network request.
- [ ] Render exact technical data from Discover variants: kind, transports, endpoint or URL, authentication requirement, command, provider docs, and official item URL.
- [ ] Keep the primary Add or Connect action visible. Dynamically import the matching existing add flow only after the action is selected.
- [ ] On successful creation, navigate to `connectedConnectorHref(projectId, newSlug)`.
- [ ] Run focused tests and ESLint.
- [ ] Commit with `feat(web): add routed catalogue connector detail`.

### Task 5: Convert connector cards to prefetched links

**Files:**
- Modify: `apps/web/src/features/workspace/capabilities/shared/catalog/catalog-card.tsx`
- Modify: `apps/web/src/features/workspace/capabilities/connectors/catalog/connector-browse.tsx`
- Modify: `apps/web/src/features/workspace/capabilities/connectors/connectors-page.tsx`
- Modify: connector-page source tests that assert modal or `?c=` behavior.

**Interfaces:**
- `CatalogCard` accepts `href?: string` and renders a Next `Link` when present. Existing button callers keep `onClick` behavior.

- [ ] Write a test that requires connected and catalogue cards to emit routed hrefs and rejects `?c=` detail selection.
- [ ] Run the focused test and confirm it fails against the current modal behavior.
- [ ] Add the optional href API to `CatalogCard` without changing existing button call sites.
- [ ] Pass catalogue hrefs through `ConnectorBrowse` and connected hrefs through `ConnectorsPage`.
- [ ] Remove catalogue-target state and add-flow imports from the list page.
- [ ] Remove connector modal state, `detailSelection`, OAuth handling, and the modal dynamic import from the list page.
- [ ] Keep the custom connector Add modal and Global rules sheet unchanged.
- [ ] Run all connector-page and catalogue tests.
- [ ] Commit with `refactor(web): route connector cards to detail pages`.

### Task 6: Responsive, performance, and real-browser verification

**Files:**
- Modify only files from Tasks 2-5 when verification finds defects.
- Update: `docs/superpowers/specs/2026-09-01-connector-detail-routes-design.md` only if verified behavior changes the contract.

**Interfaces:**
- No new production interfaces.

- [ ] Run `cd apps/web && npx eslint` on every changed TypeScript and TSX file. Require zero errors.
- [ ] Run the focused connector test set. Record pass counts and failures.
- [ ] Run the frontend typecheck and distinguish only the repository's documented `@types/bun` errors from new errors.
- [ ] Start or reuse the local stack. Confirm API health and web listener before starting another process.
- [ ] In Chromium, click one connected card. Assert the routed URL, identity, technical setup text, primary action, documentation, and horizontal tabs.
- [ ] Click one catalogue card. Assert its routed URL, exact technical labels, official/Kortix documentation links when present, and primary action.
- [ ] Open Advanced and assert transport, endpoint, authentication, access, and headers render only when available.
- [ ] Verify 390px, 768px, and desktop widths. Assert no horizontal page overflow and tabs remain reachable.
- [ ] Observe network requests. Confirm card navigation reuses the connector-list query and identity does not wait for config or account requests.
- [ ] Run `git diff --check` and inspect the final diff.
- [ ] Commit verification fixes with `fix(web): polish routed connector details` when needed.

### Task 7: Draft preview delivery

**Files:**
- No source file is required unless preview verification exposes a defect.

**Interfaces:**
- Produces the draft pull request, `preview` label, preview origin, and verification evidence.

- [ ] Push `connector-flow` and open a draft pull request against `main` after the first implementation commit if no draft already exists.
- [ ] Apply the `preview` label.
- [ ] Wait for preview deployment and `pnpm test -- --target-full` evidence.
- [ ] Verify the connected and catalogue routes on the preview origin.
- [ ] Record branch, PR, preview origin, exact commands, and outputs. Do not merge to `main` without explicit approval.
