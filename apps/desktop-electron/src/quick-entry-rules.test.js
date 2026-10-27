const { describe, expect, test } = require('bun:test');

const {
  DEFAULT_SHORTCUT,
  PENDING_TTL_MS,
  RECENT_SESSIONS,
  composerLabels,
  composerMenuItems,
  freshPrompt,
  normalizeTarget,
  pickerItems,
  keptPick,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  normalizeAttachments,
  quickEntryBounds,
  relativeTime,
  resolveShortcut,
  screenshotName,
  shortcutLabel,
} = require('./quick-entry-rules');

describe('resolveShortcut', () => {
  test('a new profile gets the default, which is not the ⌥Space other AI apps take', () => {
    expect(resolveShortcut(undefined)).toBe('CommandOrControl+Shift+Space');
    expect(DEFAULT_SHORTCUT).not.toBe('Alt+Space');
  });

  test('a saved menu choice is kept, and null keeps the shortcut off', () => {
    expect(resolveShortcut('Alt+Space')).toBe('Alt+Space');
    expect(resolveShortcut('Alt+Shift+Space')).toBe('Alt+Shift+Space');
    expect(resolveShortcut(null)).toBeNull();
  });

  test('a hand-edited or stale value falls back to the default', () => {
    expect(resolveShortcut('Command+Q')).toBe(DEFAULT_SHORTCUT);
    expect(resolveShortcut(42)).toBe(DEFAULT_SHORTCUT);
  });
});

describe('shortcutLabel', () => {
  test('names the keys the way each platform prints them', () => {
    expect(shortcutLabel('CommandOrControl+Shift+Space', 'darwin')).toBe('Command + Shift + Space');
    expect(shortcutLabel('Alt+Space', 'darwin')).toBe('Option + Space');
    expect(shortcutLabel('CommandOrControl+Shift+Space', 'win32')).toBe('Ctrl + Shift + Space');
    expect(shortcutLabel('Alt+Shift+Space', 'linux')).toBe('Alt + Shift + Space');
  });
});

describe('quickEntryBounds', () => {
  test('centers the bar at the bottom of the display under the cursor, a twentieth of the way up', () => {
    expect(quickEntryBounds({ x: 0, y: 25, width: 1440, height: 875 }, 744, 156)).toEqual({
      x: 348,
      y: 700,
      width: 744,
      height: 156,
    });
  });

  test('stays on a secondary display left of the primary one', () => {
    expect(quickEntryBounds({ x: -1920, y: 0, width: 1920, height: 1080 }, 744, 156)).toEqual({
      x: -1332,
      y: 870,
      width: 744,
      height: 156,
    });
  });
});

describe('freshPrompt', () => {
  const pending = { text: 'Summarize the open PRs', at: 1_000 };

  test('returns the prompt while the app window can still take it', () => {
    expect(freshPrompt(pending, 1_000)).toBe(pending);
    expect(freshPrompt(pending, 1_000 + PENDING_TTL_MS)).toBe(pending);
  });

  test('drops a prompt typed more than ten minutes ago, so an agent never acts on it late', () => {
    expect(freshPrompt(pending, 1_001 + PENDING_TTL_MS)).toBeNull();
    expect(freshPrompt(null, 1_000)).toBeNull();
  });
});

describe('normalizeTarget', () => {
  test('keeps the project id and a trimmed name', () => {
    expect(normalizeTarget({ projectId: 'p1', name: '  Website  ' })).toEqual({
      projectId: 'p1',
      name: 'Website',
      sessions: [],
      composer: null,
    });
  });

  test('a project with no name yet still targets the project', () => {
    expect(normalizeTarget({ projectId: 'p1', name: '' })).toEqual({ projectId: 'p1', name: null, sessions: [], composer: null });
    expect(normalizeTarget({ projectId: 'p1' })).toEqual({ projectId: 'p1', name: null, sessions: [], composer: null });
  });

  test('keeps the 5 most recent sessions, in the order the web app sent them', () => {
    const sessions = Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, title: `Task ${i}`, status: 'stopped' }));
    const target = normalizeTarget({ projectId: 'p1', sessions });
    expect(RECENT_SESSIONS).toBe(5);
    expect(target?.sessions.map((s) => s.id)).toEqual(['s0', 's1', 's2', 's3', 's4']);
  });

  test('drops a session without an id, and repairs a missing title or unknown status', () => {
    const target = normalizeTarget({
      projectId: 'p1',
      sessions: [{ title: 'no id' }, { id: 's1', title: '  ', status: 'exploded' }, 'junk', { id: 's2', title: 'Fix login', status: 'running' }],
    });
    expect(target?.sessions).toEqual([
      { id: 's1', title: 'Untitled session', status: 'stopped' },
      { id: 's2', title: 'Fix login', status: 'running' },
    ]);
  });

  test('anything without a project id clears the target', () => {
    expect(normalizeTarget(null)).toBeNull();
    expect(normalizeTarget({ name: 'Website' })).toBeNull();
    expect(normalizeTarget({ projectId: 7 })).toBeNull();
  });

  test('caps both strings, so page script cannot push an unbounded label into the bar', () => {
    const long = 'x'.repeat(500);
    const target = normalizeTarget({ projectId: long, name: long });
    expect(target?.projectId.length).toBe(200);
    expect(target?.name?.length).toBe(200);
  });
});

describe('pickerItems', () => {
  const target = normalizeTarget({
    projectId: 'p1',
    name: 'Website',
    sessions: [
      { id: 's1', title: 'Fix login', status: 'running' },
      { id: 's2', title: 'Write docs', status: 'stopped' },
    ],
  });

  test('a new session in the project comes first and is the default', () => {
    expect(pickerItems(target, null)).toEqual([
      { sessionId: null, label: 'New session', checked: true },
      { sessionId: 's1', label: 'Fix login', status: 'running', statusText: 'Running', checked: false },
      { sessionId: 's2', label: 'Write docs', status: 'stopped', statusText: 'Stopped', checked: false },
    ]);
  });

  test('checks exactly the picked session', () => {
    expect(pickerItems(target, 's2').map((item) => item.checked)).toEqual([false, false, true]);
  });

  test('a pick the web app no longer lists falls back to a new session', () => {
    expect(pickerItems(target, 'deleted').map((item) => item.checked)).toEqual([true, false, false]);
  });

  test('the next open keeps a pick while its session is live, else starts a new session', () => {
    const live = normalizeTarget({
      projectId: 'p1',
      sessions: ['running', 'starting', 'needs-you', 'done', 'stopped', 'failed'].map((status) => ({ id: status, title: status, status })),
    });
    expect(['running', 'starting', 'needs-you', 'done', 'stopped', 'failed'].map((id) => keptPick(live, id))).toEqual([
      'running',
      'starting',
      'needs-you',
      null,
      null,
      null,
    ]);
    expect(keptPick(live, 'deleted')).toBeNull();
    expect(keptPick(null, 'running')).toBeNull();
  });

  test('with no project known, only "New session" is offered', () => {
    expect(pickerItems(null, null)).toEqual([{ sessionId: null, label: 'New session', checked: true }]);
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  test('reads like the sidebar would say it', () => {
    expect(relativeTime(now - 20_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(relativeTime(now - 30 * 3_600_000, now)).toBe('Yesterday');
    expect(relativeTime(Date.parse('2026-10-09T10:00:00Z'), now)).toBe('Oct 9');
  });

  test('two untitled sessions are told apart by when they were last active', () => {
    const target = normalizeTarget({
      projectId: 'p1',
      sessions: [
        { id: 'a', title: 'New session', status: 'stopped', lastActiveAt: '2026-10-12T11:55:00Z' },
        { id: 'b', title: 'New session', status: 'stopped', lastActiveAt: '2026-10-12T09:00:00Z' },
        { id: 'c', title: 'No time', status: 'running', lastActiveAt: 'garbage' },
      ],
    });
    expect(pickerItems(target, null, now).slice(1).map((item) => item.statusText)).toEqual([
      'Stopped · 5 min ago',
      'Stopped · 3 h ago',
      'Running',
    ]);
  });
});

describe('normalizeAttachments', () => {
  const bytes = (n) => new Uint8Array(n).fill(1);

  test('keeps a screenshot as it came', () => {
    expect(normalizeAttachments([{ name: 'Screenshot.png', type: 'image/png', bytes: bytes(3) }])).toEqual([
      { name: 'Screenshot.png', type: 'image/png', bytes: bytes(3) },
    ]);
  });

  test('drops empty, oversized and malformed files, and caps the count', () => {
    const files = normalizeAttachments([
      { name: 'empty', type: 'text/plain', bytes: bytes(0) },
      { name: 'huge', type: 'video/mp4', bytes: { byteLength: MAX_ATTACHMENT_BYTES + 1 } },
      'junk',
      ...Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.txt`, type: 'text/plain', bytes: bytes(1) })),
    ]);
    expect(files).toHaveLength(MAX_ATTACHMENTS);
    expect(files[0].name).toBe('f0.txt');
  });

  test('a path in a name or a strange type cannot travel further', () => {
    expect(normalizeAttachments([{ name: '../../etc/passwd', type: 'x; evil', bytes: bytes(1) }])).toEqual([
      { name: '.._.._etc_passwd', type: 'application/octet-stream', bytes: bytes(1) },
    ]);
  });
});

describe('screenshotName', () => {
  test('names a screenshot the way macOS does', () => {
    expect(screenshotName(new Date(2026, 9, 12, 15, 4, 31))).toBe('Screenshot 2026-10-12 at 15.04.31.png');
  });
});

describe('the new session composer row', () => {
  const target = normalizeTarget({
    projectId: 'p1',
    composer: {
      agents: [
        { id: 'kortix', label: 'Kortix' },
        { id: 'meta', label: 'Meta' },
      ],
      agent: 'kortix',
      models: [{ id: 'openai:gpt', label: 'GPT-6 Astra', variants: ['high'] }],
      model: 'openai:gpt',
    },
  });

  test('labels the agent the way the composer shows it; the model and effort stay off the bar', () => {
    expect(target.composer).toEqual({ agents: [{ id: 'kortix', label: 'Kortix' }, { id: 'meta', label: 'Meta' }], agent: 'kortix' });
    expect(composerLabels(target.composer)).toEqual({ agent: 'Kortix' });
  });

  test('no composer from the web app hides the whole row', () => {
    expect(composerLabels(null)).toBeNull();
    expect(normalizeTarget({ projectId: 'p1' }).composer).toBeNull();
  });

  test('the agent menu checks the current agent; no other menu has rows', () => {
    expect(composerMenuItems(target.composer, 'agent')).toEqual([
      { value: 'kortix', label: 'Kortix', checked: true },
      { value: 'meta', label: 'Meta', checked: false },
    ]);
    expect(composerMenuItems(target.composer, 'model')).toEqual([]);
  });

  test('drops an agent the list does not hold', () => {
    const composer = normalizeTarget({ projectId: 'p1', composer: { agents: [{ id: 'kortix' }], agent: 'gone' } }).composer;
    expect(composer).toEqual({ agents: [{ id: 'kortix', label: 'kortix' }], agent: null });
    expect(composerLabels(composer)).toEqual({ agent: null });
  });
});

