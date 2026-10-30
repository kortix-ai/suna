Telegram attachments and commands, richer artifacts, and more reliable sessions

Telegram attachments and commands, richer artifacts, and more reliable sessions

### New
- Send photos, files and voice notes to a Telegram bot and see them in the session (#11091, #11094).
- Use Telegram /help, /status, /new, /stop, /model and /agent commands, with button menus for models and agents (#11097, #11105).
- Drive your own Chrome from a session when the Chrome feature flag is enabled (#9745).
- Add artifact comment threads and permissions (KRTX-3661, e672225), activity history and author receipts (KRTX-3662, 8bf7060), and SDK and CLI comments (KRTX-3663, 813e351).
- Work with artifact editor blocks, link cards, an Ask AI sheet and a smoother gallery (#11111).
- Find Instagram content studio and Instagram Reels skills in the marketplace (#11116).

### Improved
- Restore lost conversations from the session log across deployments and preserve running turns when a box dies (#11032, #11043).
- Run sessions on pi 1.4.0 with a faster daemon boot (#11087).
- Approving a held connector call runs it once as the original caller; agents also receive clearer guidance about repeating approved calls (#11103, #11095).
- Browse fitted navigation menus, a cleaner hero walkthrough and a refreshed Services page; the standalone /cli page is removed (#11092, #11096).
- Follow step-by-step setup guides on use-case pages, with new product-scene covers and filled icons (#11100, #11102).
- Receive transactional emails in a shared React Email shell (#11101).

### Fixed
- Keep large images from stalling daemon health checks and event streams (#11029).
- Restore a workspace-volume session from its S3 snapshot when lost+found remains (#11099).
- Repair unsafe Unicode in prompt parts and wait for Platinum derived images before using them (#11080, #11081).
- Preserve the built-in Telegram channel when a user connector uses its reserved name (#11084).
- Place image full-screen hints at the image corner and show every artifact block-menu row without scroll bars (#11112, #11114).
- Filter wallet missing-account and Talisman onboarding noise in the web app (#11107, #11108).
- Generate valid pattern schemas and give the HEIC browser test time to complete (#11074).
- Upload the production Vercel deployment as one archive and stamp its release commit (#11088).

### Security
- Patch seroval, re2js, systeminformation and @hono/node-server advisories, including the scanner pin and subsequent systeminformation update (#11070, #11073, #11077).

### Internal
- Share channel webhook routing and platform descriptors across the API and Channels UI without changing existing output (#11082, #11085, #11086).
- Stop current clients from requesting the old transcript endpoint, remove v1 transcript-mirror reads and avoid writes for unchanged journal re-sends (#11034, #11033, #11104).
- Type gateway analytics timeout errors (#11076).
- Document fixes against the frozen staging candidate and gate browser shards on RELEASE_BROWSER_LANES=on (#11063, #11064).
- Regenerate the developers' kortix.yaml reference and update agent planning guidance (#11067, #11113).
- Advance the development version to 0.14.10 after 0.14.9 (b1f87c4).
