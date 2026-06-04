Restore the site — fix the production render crash

### Fixed
- The site was showing "Something went wrong" on every page after the last release. The page metadata was being built from an environment value that wasn't a valid URL, which crashed server-side rendering across the whole site. The base URL is now validated (and falls back to the canonical domain), restoring all pages.
