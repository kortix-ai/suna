// Regenerates src/services/llm-gateway/models/codex-models.seed.json from the Codex CLI's
// models.json. A standalone entry point on purpose: a top-level `await` inside
// codex-models.ts made that widely imported module async, and the reordered
// module evaluation broke an unrelated auth path (PROJ-38: anonymous 401 → 403).
import { CODEX_MODELS_URL, parseCodexModelIds } from '../src/services/llm-gateway/models/codex-models';

const res = await fetch(CODEX_MODELS_URL);
if (!res.ok) throw new Error(`${CODEX_MODELS_URL}: HTTP ${res.status}`);
const ids = parseCodexModelIds(await res.json());
await Bun.write(
  new URL('../src/services/llm-gateway/models/codex-models.seed.json', import.meta.url),
  `${JSON.stringify(ids, null, 2)}\n`,
);
console.log(`codex seed: ${ids.join(', ')}`);
