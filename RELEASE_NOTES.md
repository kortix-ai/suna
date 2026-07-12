Steadier session switching, email-code sign-in, and a batch of fixes

### Fixed
- Switching between sessions no longer flashes a "Something went wrong" screen. A brief "runtime still starting" state during a session switch now shows a short loader and recovers on its own instead of surfacing as an error.
- The review inbox (sidebar and Review Center) keeps loading even when one of its sources is temporarily unavailable — it now degrades gracefully instead of failing the whole panel.
- Session file uploads are recoverable again after an interruption.
- PDF previews now open at 100% zoom instead of 50%.
- Sign-in polish on mobile: the mark is pinned top-left, gutters are wider, and the tagline is refreshed.

### New and improved
- Signing in now defaults to a one-time email code, with password kept as a secondary option.
- Projects still on the older manifest now show a clear v1 → v2 upgrade prompt in the sidebar.
- Maintenance mode: admins can bypass a full lockdown through a signed session, and deploys now raise a heads-up banner while a rollout is in progress and clear it automatically once the API is healthy.
