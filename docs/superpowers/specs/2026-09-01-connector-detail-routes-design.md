# Connector detail routes and guided connection flow

## Problem

The connectors catalogue presents connector cards clearly. The next step does not.

Connected cards open a large modal with Accounts, Tools, and Settings navigation. The modal combines connection state, account management, tool permissions, and administrative settings. A user must inspect several tabs before they know what to do.

Catalogue cards open different modal flows. Those flows do not provide a stable page that can explain the connector, show documentation, or survive navigation and OAuth redirects.

The result is difficult for non-technical users and slow to understand. The current connector detail also loads a large client-side dependency graph after the first click.

## Goals

- Give every connector card a stable detail route.
- Show one clear primary action above secondary configuration.
- Explain the connection process as a short ordered flow.
- Show Kortix documentation and the connector's official website or documentation when available.
- Keep Accounts, Tools, and Settings available for connected connectors.
- Move transport, endpoint, authentication, access scope, and custom headers into an Advanced disclosure when they are not required for the immediate action.
- Improve perceived and measured detail-page load time.
- Preserve existing connection, credential, permission, and removal behavior.
- Support narrow mobile, tablet, and desktop widths.

## Non-goals

- Do not change the Global rules sheet or its policies UI.
- Do not copy the Paper sidebar.
- Do not change connector API contracts or SDK public exports.
- Do not redesign the catalogue taxonomy, search, or category behavior.
- Do not hide the primary Connect, Reconnect, Add credential, or approval action in an Advanced disclosure.
- Do not fabricate documentation URLs.

## Reference direction

Use the inset content from Paper nodes `RWA-0`, `S7M-0`, and `SI8-0`.

The routed page uses these patterns:

- a compact connector identity header;
- one primary connection action;
- a support area with concise ordered instructions;
- visible documentation links;
- labeled MCP and custom-connector configuration rows.

Kortix retains its current project sidebar and capability navigation.

## Routes

### Catalogue detail

`/projects/:projectId/connectors/catalog/:source/:slug`

This route represents a connector that is available but not yet added to the project. `source` disambiguates Discover, Easy Connect, and Computer records whose slugs can overlap.

The page shows:

- connector identity and description;
- connection requirements;
- a primary Add or Connect action;
- three short setup steps;
- Kortix and official documentation links when available;
- an Advanced disclosure for protocol details when the record provides them.

The existing create and authorization mutations remain the source of truth. The routed page hosts their entry action and preserves their validation behavior.

### Connected detail

`/projects/:projectId/connectors/:slug`

This route represents a project connector. It replaces the connector detail modal.

The page shows:

- connector identity, status, and plain-language connection state;
- one primary Connect, Reconnect, Add credential, or Replace credential action;
- a concise next-step explanation;
- documentation links;
- Accounts, Tools, and Settings in horizontal tabs;
- an Advanced disclosure for protocol and connector metadata.

OAuth redirects return to this route. Query parameters used by the existing OAuth completion flow remain intact.

### Existing connector list

`/projects/:projectId/connectors`

Connected cards navigate to the connected detail route. Catalogue cards navigate to the catalogue detail route. Search, categories, tabs, and Global rules keep their current behavior.

The custom connector Add modal remains in scope only as an existing creation flow. This work does not convert Global rules into a route.

## Page hierarchy

The detail page uses one content column inside the existing capability shell.

1. Back link to Connectors.
2. Connector identity header.
3. Primary connection panel.
4. Setup guidance and documentation.
5. Accounts, Tools, and Settings for connected connectors.
6. Advanced disclosure.

The primary panel contains the current state and one action. It does not contain tool permissions, headers, or removal controls.

The setup guidance uses no more than three steps:

1. Start the connection.
2. Complete the provider or credential step.
3. Return to Kortix and confirm the connected state.

Provider-specific text can replace a step only when the connector record supplies the required information.

## Progressive disclosure

The default view shows information required to decide and complete the next action.

Keep these items visible:

- connection status;
- primary connection action;
- account or workspace ownership when it affects access;
- required approval or credential requirement;
- Kortix documentation link;
- official documentation or website link.

Place these items in Advanced when present:

- transport type;
- endpoint or server URL;
- authentication scheme details;
- access scope details;
- custom headers;
- connector slug and internal identifiers;
- destructive administrative controls that do not affect initial setup.

Settings remains a top-level tab for connected connectors. Advanced does not replace settings. It reduces the amount of protocol information shown before the user needs it.

## Component architecture

### `ConnectorDetailPage`

Owns the connected connector query, route state, connection state, OAuth completion handling, and page composition.

It receives `projectId` and `slug`. It renders a shape-matched skeleton while the connector resolves.

### `CatalogConnectorDetailPage`

Resolves one catalogue entry by `source` and `slug`. It renders the catalogue identity, guidance, documentation, and the existing add-flow entry action.

### `ConnectorDetailHeader`

Renders the back link, connector icon, name, status, description, and primary action. It contains no tab navigation.

### `ConnectorSetupGuide`

Renders up to three ordered steps. Copy remains short and uses plain terms.

### `ConnectorDocumentationLinks`

Renders only verified URLs from connector data or an explicit Kortix documentation mapping. It never guesses provider URLs.

### `ConnectorAdvancedDisclosure`

Renders optional protocol and administrative metadata. It is collapsed by default and keyboard accessible.

### Existing connected sections

`ConnectorAccounts`, `ConnectorTools`, and `ConnectorSettings` remain the behavior owners. The implementation moves their composition from the modal body to the routed page. It does not duplicate their mutations.

## Data flow

The list page already loads project connectors. Card navigation passes only route identifiers. The detail route reads the same React Query keys used by the list page, which permits instant cache reuse during client navigation.

The connected detail route selects one connector from `qk.project.connectors(projectId)`. It does not add a second connector-detail request.

Connection and project queries keep their existing cache keys. Mutations invalidate the existing authorization-derived keys. OAuth completion invalidates those keys and removes only OAuth result parameters.

Catalogue detail queries use source-specific keys. The route fetches only the selected record or selected record details. It does not load the full connector modal bundle.

## Performance design

- Use Next.js route-level code splitting for connected and catalogue detail pages.
- Remove the connected-detail modal import from the catalogue page's initial client chunk.
- Keep credential, Pipedream, and custom-connector flows dynamically imported until the user selects their action.
- Reuse `qk.project.connectors(projectId)` so client navigation can paint cached connector identity immediately.
- Render the route shell and shape-matched skeleton without waiting for secondary connection or documentation data.
- Fetch secondary data in parallel after the connector identity resolves.
- Keep documentation mappings and setup-copy helpers framework-free and small.
- Avoid loading catalogue pagination, category, and grid code on a connected detail route.
- Prefetch a connector detail route on card hover or focus through the existing Next link behavior.
- Keep images bounded and lazy. Reuse the existing connector icon component.

Performance verification records:

- the connector list route client chunk no longer includes `connector-modal.tsx`;
- a card click changes the URL and paints the detail skeleton immediately;
- the identity and primary action do not wait for Accounts, Tools, or documentation queries;
- browser navigation does not produce duplicate connector-list requests.

## Responsive behavior

- The page uses one column below `lg`.
- Identity copy and actions wrap without clipping.
- The primary action becomes full width on narrow screens.
- Horizontal tabs scroll when they do not fit.
- Protocol rows stack their label and value on narrow containers.
- Icons and fixed controls use `shrink-0`; flexible text containers use `min-w-0`.
- Click targets meet the existing Kortix mobile touch-target rules.

## Error handling

- A missing connected slug shows a connector-not-found state with a return action.
- A failed connector-list query shows Retry.
- Secondary connection-query failure leaves identity and documentation visible. The Accounts panel shows its focused error state.
- Missing documentation URLs omit the link. The page does not show a disabled or guessed link.
- A catalogue source or slug mismatch shows a catalogue-not-found state.
- Mutation errors use the existing toast and inline error behavior.
- A connector removed from another tab returns the user to the connector list after the next successful list result confirms removal.

## Testing

### Focused tests

- Connected card href generation.
- Catalogue card href generation for every source.
- Connected detail selection and not-found behavior.
- Primary-action visibility for connected, unconnected, project-owned, user-owned, channel, computer, and credential-based connectors.
- Documentation-link omission when URLs are absent.
- Advanced disclosure content rules.
- Existing connector Accounts, Tools, and Settings tests remain green.

### Browser verification

- Open a connected connector card and assert the routed URL, visible identity, status, primary action, and tab navigation.
- Open a catalogue connector card and assert the routed URL, setup steps, documentation links, and Add or Connect action.
- Exercise an OAuth or credential action and confirm its existing flow opens only after the action click.
- Verify narrow mobile, tablet, and desktop layouts.
- Observe network requests and confirm the detail identity does not wait for secondary queries.

## Delivery

Work remains on the canonical `connector-flow` branch. The first implementation commit opens a draft pull request with the `preview` label. The branch does not merge to `main` without explicit user approval.

Linear issue: `JAY-792`.
