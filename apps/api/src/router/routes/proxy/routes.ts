import { proxy, services } from './app';
import { handleCodexSubscriptionProxy } from './codex-subscription';
import { handleProxy } from './handlers';

for (const [prefix, serviceConfig] of Object.entries(services)) {
  proxy.all(`/${prefix}/*`, (c) => handleProxy(c, serviceConfig, prefix));
  proxy.all(`/${prefix}`, (c) => handleProxy(c, serviceConfig, prefix));
}

// Codex/ChatGPT SUBSCRIPTION proxy — deliberately NOT one of the generic
// `services` above (those always inject Kortix's own key + bill Kortix
// credits). See codex-subscription.ts's header comment and
// docs/specs/2026-07-21-codex-billing-leak-verification.md.
proxy.all('/codex-subscription/*', handleCodexSubscriptionProxy);
