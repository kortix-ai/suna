Smoother, more reliable session loading

Session loading is now clean end-to-end:
- The chat input no longer jumps to the top of the page while a session connects.
- No more brandmark 'arcs' bleeding through behind the loader on a fresh session.
- The loader and the session shell never show at the same time — connecting shows just the loader, ready shows the full session, never both at once.
- More reliable Slack session handling (session lifecycle now goes through the unified openSession path).
