/**
 * Workflows every session has, as Claude Code bundles `/deep-research`
 * (https://code.claude.com/docs/en/workflows#bundled-workflows). The workflow
 * tool runs one by `name` when the project has no saved workflow of that name
 * (a project file wins), and the session lists each as a `/name` command
 * (runtime.ts `commandList`).
 */

/** The bundled scripts, by name. */
export const BUNDLED_WORKFLOWS: Record<string, { description: string; script: string; maxAgents: number }> = {
  'deep-research': {
    description: 'Research a question across many sources, cross-check every claim, and write a cited report',
    // 1 planner + at most 6 searchers + 2 verifiers for each of at most 6 batches + 1 writer.
    maxAgents: 20,
    script: String.raw`export const meta = {
  name: 'deep-research',
  description: 'Research a question across many sources and cross-check the claims',
  phases: [
    { title: 'Plan', detail: 'Split the question into search angles' },
    { title: 'Search', detail: 'One agent per angle searches and reads sources' },
    { title: 'Verify', detail: 'Two independent agents check each claim against its sources' },
    { title: 'Report', detail: 'A cited report of the claims that held' },
  ],
}

const question = String(typeof args === 'string' ? args : (args && args.question) || '').trim()
if (!question) throw new Error('deep-research needs a question: pass args: { question: "..." }.')

phase('Plan')
const plan = await agent(
  'Plan web research for this question:\n\n' + question + '\n\n' +
    'List 3 to 6 distinct angles that together answer it (official docs, changelogs and release notes, issue trackers, independent analysis, data). ' +
    'For each angle give 2 or 3 concrete web search queries. Do not answer the question yet.',
  {
    label: 'Plan the search angles',
    schema: {
      type: 'object',
      required: ['angles'],
      properties: {
        angles: {
          type: 'array', minItems: 1, maxItems: 6,
          items: { type: 'object', required: ['angle', 'queries'], properties: { angle: { type: 'string' }, queries: { type: 'array', items: { type: 'string' } } } },
        },
      },
    },
  },
)

phase('Search')
const found = await parallel(plan.angles.map((angle) => () => agent(
  'Research one angle of this question with web_search and scrape_webpage.\n\nQuestion: ' + question + '\nAngle: ' + angle.angle +
    '\nStart from these queries: ' + angle.queries.join('; ') +
    '\n\nRead the sources themselves, not only search snippets. Return up to 8 specific, checkable claims that answer the question, each with the URLs that state it and a short quote.',
  {
    label: angle.angle,
    schema: {
      type: 'object',
      required: ['claims'],
      properties: {
        claims: {
          type: 'array',
          items: { type: 'object', required: ['claim', 'sources'], properties: { claim: { type: 'string' }, sources: { type: 'array', items: { type: 'string' } }, quote: { type: 'string' } } },
        },
      },
    },
  },
)))
const claims = found.filter(Boolean).flatMap((result) => result.claims).filter((claim) => claim.sources.length > 0)
log(claims.length + ' claims from ' + found.filter(Boolean).length + ' angles')

phase('Verify')
const batches = []
for (let i = 0; i < claims.length && batches.length < 6; i += 8) batches.push(claims.slice(i, i + 8))
const verdictSchema = {
  type: 'object',
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: { type: 'object', required: ['index', 'verdict'], properties: { index: { type: 'integer' }, verdict: { enum: ['supported', 'refuted', 'unverified'] }, note: { type: 'string' } } },
    },
  },
}
const checked = await parallel(batches.flatMap((batch, b) => [1, 2].map((reviewer) => () => agent(
  'Check each claim against its sources. Open every URL with scrape_webpage. A claim is "supported" only when a source states it; "refuted" when a source contradicts it; "unverified" when you could not read the sources. Be strict.\n\n' +
    batch.map((claim, i) => i + '. ' + claim.claim + '\n   sources: ' + claim.sources.join(' ')).join('\n'),
  { label: 'Check batch ' + (b + 1) + ' (reviewer ' + reviewer + ')', schema: verdictSchema },
).then((result) => ({ b, result })))))
const votes = new Map()
for (const entry of checked.filter(Boolean)) {
  for (const verdict of (entry.result && entry.result.verdicts) || []) {
    const key = entry.b + ':' + verdict.index
    votes.set(key, [...(votes.get(key) || []), verdict.verdict])
  }
}
const kept = []
const unverified = []
batches.forEach((batch, b) => batch.forEach((claim, i) => {
  const vote = votes.get(b + ':' + i) || []
  if (vote.includes('refuted')) return
  if (vote.length >= 2 && vote.every((v) => v === 'supported')) kept.push(claim)
  else unverified.push(claim)
}))
log(kept.length + ' claims held, ' + unverified.length + ' unverified')

phase('Report')
return await agent(
  'Write a concise research report that answers this question:\n\n' + question + '\n\n' +
    'Use only these verified claims, and cite the source URLs of each claim inline:\n' + JSON.stringify(kept, null, 2) +
    '\n\nAfter the report, list these claims under "Unverified" (no reviewer could confirm them; say so, do not present them as facts):\n' + JSON.stringify(unverified, null, 2),
  { label: 'Write the cited report' },
)
`,
  },
}
