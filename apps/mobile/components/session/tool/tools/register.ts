/**
 * Loads every registered tool renderer. Mirrors web `tool/tools/register.ts`.
 * Each family file imports its `*-tool.tsx` files, and each of those calls
 * `ToolRegistry.register(...)` at module load.
 */
import './register-files';
import './register-web';
import './register-agents';
import './register-projects';
