# Firefox-based Stealth Backend (Proposal)

> Status: Draft proposal
> Created: 2026-05-26
> Tracking issue: TBD

## Goal

Optional Firefox-based stealth backend for the agent browser layer, parallel to the existing Playwright Chromium path. Selected via a config flag, no change to defaults.

## Motivation

The agent reaches the open web through Playwright. A growing share of SaaS targets (Cloudflare, Akamai, Datadome) return 403 or empty content when fingerprinted as automation. A second engine with stealth patches at the C++ source level gives Suna deployments a fallback when Chromium-based sessions get blocked.

## Proposed change

A small option in the browser launch path that, when configured, uses `invisible_playwright` instead of standard Playwright. `invisible_playwright` is a drop-in Playwright Python replacement that drives a patched Firefox 150 binary (https://github.com/feder-cr/invisible_firefox, MPL-2, same license as Firefox upstream). Fingerprint randomization happens at the C++ level rather than via JS injection, so there are no detectable shims.

Drop-in compatible with the existing `playwright.async_api` usage. Same `BrowserContext`, same page handles, same agent tool calls.

## Out of scope

No change to default backend. No new agent tools. No changes to the FastAPI worker structure beyond the launch path. Backend selection stays user-driven.

## Maintenance

Issues against the backend route to feder-cr/invisible_playwright. Only ask of this repo would be the small launch-path switch plus a config entry.
