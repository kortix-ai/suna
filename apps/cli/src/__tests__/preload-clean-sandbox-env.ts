// Scrub the host sandbox's injected env for every test process. See the
// comment in the sibling bunfig.toml.
for (const key of [
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_FRONTEND_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_SESSION_ID',
  'KORTIX_SUPERVISED',
]) {
  delete process.env[key];
}
