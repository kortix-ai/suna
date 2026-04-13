import { describe, expect, it } from 'bun:test'

import { selectLingeringBusySessionIds } from '../../opencode/plugin/kortix-system/kortix-system'

describe('kortix-system startup busy session cleanup', () => {
	it('selects only pre-start busy sessions without active task runs', () => {
		expect(selectLingeringBusySessionIds({
			candidateBusySessionIds: ['stale-busy', 'fresh-busy', 'task-owned', 'missing-from-list'],
			sessions: [
				{ id: 'stale-busy', time: { updated: 1_000 } },
				{ id: 'fresh-busy', time: { updated: 5_000 } },
				{ id: 'task-owned', time: { updated: 500 } },
			],
			activeTaskSessionIds: new Set(['task-owned']),
			cleanupStartedAt: 2_000,
		})).toEqual(['stale-busy', 'missing-from-list'])
	})

	it('returns no lingering sessions when every busy session is fresh or task-owned', () => {
		expect(selectLingeringBusySessionIds({
			candidateBusySessionIds: ['fresh-busy', 'task-owned'],
			sessions: [
				{ id: 'fresh-busy', time: { updated: 5_000 } },
				{ id: 'task-owned', time: { updated: 500 } },
			],
			activeTaskSessionIds: new Set(['task-owned']),
			cleanupStartedAt: 2_000,
		})).toEqual([])
	})
})
