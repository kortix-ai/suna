Smoother session open and switch, plus marketing and maintenance-banner polish

### Fixed
- Opening or switching sessions no longer flashes a blank screen. A brief "runtime still starting" moment during a switch is now treated as a loading state, not an error, so the session just renders in place.
- A session whose sandbox had gone idle no longer dead-ends on "open a new session." It now resumes on its own, with an in-place Restart if it can't wake automatically.
- Cleaned up the marketing site: removed dead Compare links from the footer, dropped Blog from the nav, and fixed the CLI footer link.

### Improved
- The deploy maintenance banner is clearer and on-brand, and is treated as a critical rollout signal.
