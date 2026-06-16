Faster, more reliable session start

This release focuses entirely on making sessions start faster and more reliably.

## Improved
- **Sessions open faster.** The computer behind a session now warms up earlier and is prefetched as you navigate, so there's less waiting before you can start typing. Under the hood we also trimmed cold-start time (lighter tool loading, a pre-warmed runtime baked into the image).
- **A single, clearer loading screen.** Starting a session now shows one consistent loader with clear steps, instead of overlapping or flickering states.
- **Titles appear right away.** A session picks up its title as soon as the agent names it, rather than staying unnamed until your next message.

## Fixed
- Sessions no longer get stuck on the loading screen — start-up now retries on its own when a transient hiccup (like a momentarily missing sandbox id) would previously leave it stranded.
- Your first message stays visible while the session connects, instead of briefly disappearing.
- Warm sandboxes are now prepared for the person actually opening the session, not always the project owner.
