/** A settings tab. Its own module, so UI state stores import it without the menu registry. */
export type SettingsTabId =
  | 'general'
  | 'security'
  | 'appearance'
  | 'sounds'
  | 'notifications'
  | 'billing'
  | 'transactions'
  | 'referrals'
  | 'tokens'
  | 'shortcuts';
