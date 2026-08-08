# Capability Navigation Cache Design

**Linear project:** `customize` (team `Jay`)

**Linear milestone:** `5 · Navigation performance`

**Plan:** [Capability navigation cache optimization plan](https://linear.app/sutharjay/document/capability-navigation-cache-optimization-plan-cda21e94acd7)

## Problem

Switching between Connectors, Skills, and Commands displays the full capability
skeleton. Returning to a visited tab displays it again even while React Query
still holds the page data.

## Cause

The routes are dynamic and use a shared `loading.tsx` boundary. Next.js 16 gives
dynamic page segments a client-cache TTL of zero by default. Normal Link
prefetching stops at the loading boundary.

The shared `project-detail` query has a 10-second freshness window. The global
QueryClient disables remount refetching, so stale capability data does not
refresh when a user returns to Skills or Commands.

## Design

Every visible capability tab uses full route prefetching. This warms the route
payload and client chunk under Next.js's five-minute static client-cache window.
The change remains local to these three links.

Capability query options explicitly refresh on mount when their cached data is
stale. TanStack Query continues to return cached data during that background
request. Cold loads retain the existing skeleton, error, and retry states.

The connector catalogs retain their existing source-specific freshness windows.
This change covers only `project-detail` and the project connector list.

## Verification

Tests cover full prefetch on all capability links and the query freshness
contracts. Browser verification covers Connectors to Skills to Commands to
Skills, visible content during stale refresh, and request counts.

The change ships through a scoped PR, Deploy Dev, and repeated DOM and network
assertions on `dev.kortix.com`.

## Non-Goals

- Do not merge the routes into one client page.
- Do not enable global dynamic-route caching.
- Do not enable Cache Components or partial prefetching.
- Do not change connector catalog pagination or freshness.
