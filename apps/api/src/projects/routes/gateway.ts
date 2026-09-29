/**
 * Side-effect entry for the gateway routes: importing this module registers
 * every `/{projectId}/gateway/*` route on `projectsApp`. The routes live in
 * the sibling modules next to this file — one per job (logs, spend, keys,
 * playground, providers, routing policy) — so put a new gateway route in the
 * sibling that owns its job instead of here.
 */
import './gateway-logs';
import './gateway-spend';
import './gateway-keys';
import './gateway-playground';
import './gateway-providers';
import './gateway-routing-policy';
