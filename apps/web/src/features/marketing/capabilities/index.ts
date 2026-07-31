/**
 * Four passages, mounted independently and distributed through the home page.
 * They were one 2,626px section; splitting them was the point, so nothing here
 * re-exports a combined block.
 *
 * Recommended order on `app/(public)/(marketing)/page.tsx`:
 *
 *   hero → logo strip → layer stack → AgentsSection → use cases →
 *   ChannelsSection → asking interlude → AutomationsSection → open source →
 *   owning interlude → ControlSection → trust → CTA
 *
 * Each file records why it sits where it sits. The one hard constraint is that
 * `ChannelsSection` and `AutomationsSection` must never be adjacent.
 */
export { AgentsSection } from './agents-section';
export { AutomationsSection } from './automations-section';
export { ChannelsSection } from './channels-section';
export { ControlSection } from './control-section';
