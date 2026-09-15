/**
 * A real migrated legacy Suna `complete` part (content shortened, shape and
 * field names verbatim). Produced by the legacy transfer projection:
 * `providerID: 'legacy'`, `metadata.legacy_source_message_id` on the state.
 */
export const LEGACY_COMPLETE_TEXT = [
  'All four missing premiums are filled in, and I found one error in your existing data.',
  '',
  '| Position | Notional | Prem (Spend) |',
  '|---|---|---|',
  '| 6% 10y SOFR Dec 2026 | 3,810,000 | **400,000.47** |',
  '',
  'Total premium across all six positions: **$1,722,502**.',
].join('\n');

export const LEGACY_COMPLETE_PART = {
  id: 'prt_01a0a0f4720f460bfbe25b094e65b341c009cb49701d0000c28c9f75',
  sessionID: 'ses_f59fb4805ffee4LnBl4gJAU0oW',
  messageID: 'msg_01a0a0f4720f460bfbe25b094e65b341c009cb49701dc28c9f75',
  type: 'tool',
  callID: 'toolu_018gXt8s3w3WGxU5YTDnL5yR',
  tool: 'complete',
  state: {
    status: 'completed',
    input: {
      text: LEGACY_COMPLETE_TEXT,
      attachments: 'Macro_Hedge_Positions_Completed.xlsx',
      follow_up_prompts: [
        'Show current mark-to-market and P&L on all six macro hedge positions',
        'Break out the premium spend and current MTM by fund',
      ],
    },
    output: '{"status": "complete"}',
    title: 'complete',
    metadata: { legacy_source_message_id: 'c3452e75-98a3-4754-860a-afe3e495c4c2' },
    time: { start: 1789406769679, end: 1789406769681 },
  },
};
