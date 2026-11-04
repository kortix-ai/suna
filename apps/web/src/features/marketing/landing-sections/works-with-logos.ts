/**
 * Models Kortix runs and apps it connects to, for the works-with strip. Glyphs
 * are in public/media/landing/logos: simple-icons (CC0) plus the provider icons
 * from public/provider-icons for brands simple-icons lacks.
 *
 * Capabilities, not customers: never put a customer logo in this list.
 *
 * `color` is the brand colour (simple-icons `hex`, or the brand's own for the
 * provider icons), shown on hover. `null` for near-black brands (X, GitHub,
 * Notion…): they hover to the theme's ink so they stay visible in dark mode.
 * Raw colour lives here, in this art module, and nowhere in the components.
 */
export const WORKS_WITH = [
  { slug: 'claude', name: 'Claude', color: '#D97757' }, // audit:allow third-party brand colour
  { slug: 'slack', name: 'Slack', color: null },
  { slug: 'openai', name: 'OpenAI', color: '#412991' }, // audit:allow third-party brand colour
  { slug: 'notion', name: 'Notion', color: null },
  { slug: 'googlegemini', name: 'Gemini', color: '#8E75B2' }, // audit:allow third-party brand colour
  { slug: 'github', name: 'GitHub', color: null },
  { slug: 'openrouter', name: 'OpenRouter', color: '#6467F2' }, // audit:allow third-party brand colour
  { slug: 'linear', name: 'Linear', color: '#5E6AD2' }, // audit:allow third-party brand colour
  { slug: 'anthropic', name: 'Anthropic', color: null },
  { slug: 'perplexity', name: 'Perplexity', color: '#1FB8CD' }, // audit:allow third-party brand colour
  { slug: 'ollama', name: 'Ollama', color: null },
  { slug: 'huggingface', name: 'Hugging Face', color: '#FFD21E' }, // audit:allow third-party brand colour
  { slug: 'linkedin', name: 'LinkedIn', color: '#0A66C2' }, // audit:allow third-party brand colour
  { slug: 'gmail', name: 'Gmail', color: '#EA4335' }, // audit:allow third-party brand colour
  { slug: 'youtube', name: 'YouTube', color: '#FF0000' }, // audit:allow third-party brand colour
  { slug: 'instagram', name: 'Instagram', color: '#FF0069' }, // audit:allow third-party brand colour
  { slug: 'x', name: 'X', color: null },
  { slug: 'discord', name: 'Discord', color: '#5865F2' }, // audit:allow third-party brand colour
  { slug: 'figma', name: 'Figma', color: '#F24E1E' }, // audit:allow third-party brand colour
  { slug: 'jira', name: 'Jira', color: '#0052CC' }, // audit:allow third-party brand colour
  { slug: 'confluence', name: 'Confluence', color: null },
  { slug: 'asana', name: 'Asana', color: '#F06A6A' }, // audit:allow third-party brand colour
  { slug: 'trello', name: 'Trello', color: '#0052CC' }, // audit:allow third-party brand colour
  { slug: 'hubspot', name: 'HubSpot', color: '#FF7A59' }, // audit:allow third-party brand colour
  { slug: 'salesforce', name: 'Salesforce', color: '#00A1E0' }, // audit:allow third-party brand colour
  { slug: 'stripe', name: 'Stripe', color: '#635BFF' }, // audit:allow third-party brand colour
  { slug: 'shopify', name: 'Shopify', color: '#7AB55C' }, // audit:allow third-party brand colour
  { slug: 'zendesk', name: 'Zendesk', color: null },
  { slug: 'intercom', name: 'Intercom', color: '#6AFDEF' }, // audit:allow third-party brand colour
  { slug: 'googledrive', name: 'Google Drive', color: '#4285F4' }, // audit:allow third-party brand colour
  { slug: 'googlecalendar', name: 'Google Calendar', color: '#4285F4' }, // audit:allow third-party brand colour
  { slug: 'googlesheets', name: 'Google Sheets', color: '#34A853' }, // audit:allow third-party brand colour
  { slug: 'googledocs', name: 'Google Docs', color: '#4285F4' }, // audit:allow third-party brand colour
  { slug: 'googlemeet', name: 'Google Meet', color: '#00897B' }, // audit:allow third-party brand colour
  { slug: 'googleads', name: 'Google Ads', color: '#4285F4' }, // audit:allow third-party brand colour
  { slug: 'dropbox', name: 'Dropbox', color: '#0061FF' }, // audit:allow third-party brand colour
  { slug: 'airtable', name: 'Airtable', color: '#18BFFF' }, // audit:allow third-party brand colour
  { slug: 'gitlab', name: 'GitLab', color: '#FC6D26' }, // audit:allow third-party brand colour
  { slug: 'bitbucket', name: 'Bitbucket', color: '#0052CC' }, // audit:allow third-party brand colour
  { slug: 'vercel', name: 'Vercel', color: null },
  { slug: 'supabase', name: 'Supabase', color: '#3FCF8E' }, // audit:allow third-party brand colour
  { slug: 'postgresql', name: 'PostgreSQL', color: '#4169E1' }, // audit:allow third-party brand colour
  { slug: 'mysql', name: 'MySQL', color: '#4479A1' }, // audit:allow third-party brand colour
  { slug: 'mongodb', name: 'MongoDB', color: '#47A248' }, // audit:allow third-party brand colour
  { slug: 'redis', name: 'Redis', color: '#FF4438' }, // audit:allow third-party brand colour
  { slug: 'snowflake', name: 'Snowflake', color: '#29B5E8' }, // audit:allow third-party brand colour
  { slug: 'databricks', name: 'Databricks', color: '#FF3621' }, // audit:allow third-party brand colour
  { slug: 'datadog', name: 'Datadog', color: '#632CA6' }, // audit:allow third-party brand colour
  { slug: 'sentry', name: 'Sentry', color: '#362D59' }, // audit:allow third-party brand colour
  { slug: 'pagerduty', name: 'PagerDuty', color: '#06AC38' }, // audit:allow third-party brand colour
  { slug: 'grafana', name: 'Grafana', color: '#F46800' }, // audit:allow third-party brand colour
  { slug: 'twilio', name: 'Twilio', color: '#F22F46' }, // audit:allow third-party brand colour
  { slug: 'mailchimp', name: 'MailChimp', color: '#FFE01B' }, // audit:allow third-party brand colour
  { slug: 'zoom', name: 'Zoom', color: '#0B5CFF' }, // audit:allow third-party brand colour
  { slug: 'whatsapp', name: 'WhatsApp', color: '#25D366' }, // audit:allow third-party brand colour
  { slug: 'telegram', name: 'Telegram', color: '#26A5E4' }, // audit:allow third-party brand colour
  { slug: 'reddit', name: 'Reddit', color: '#FF4500' }, // audit:allow third-party brand colour
  { slug: 'facebook', name: 'Facebook', color: '#0866FF' }, // audit:allow third-party brand colour
  { slug: 'tiktok', name: 'TikTok', color: null },
  { slug: 'pinterest', name: 'Pinterest', color: '#BD081C' }, // audit:allow third-party brand colour
  { slug: 'calendly', name: 'Calendly', color: '#006BFF' }, // audit:allow third-party brand colour
  { slug: 'quickbooks', name: 'QuickBooks', color: '#2CA01C' }, // audit:allow third-party brand colour
  { slug: 'xero', name: 'Xero', color: '#13B5EA' }, // audit:allow third-party brand colour
  { slug: 'clickup', name: 'ClickUp', color: '#7B68EE' }, // audit:allow third-party brand colour
  { slug: 'miro', name: 'Miro', color: null },
  { slug: 'canva', name: 'Canva', color: '#00C4CC' }, // audit:allow third-party brand colour
  { slug: 'webflow', name: 'Webflow', color: '#146EF5' }, // audit:allow third-party brand colour
  { slug: 'wordpress', name: 'WordPress', color: '#21759B' }, // audit:allow third-party brand colour
  { slug: 'googleanalytics', name: 'Google Analytics', color: '#E37400' }, // audit:allow third-party brand colour
  { slug: 'posthog', name: 'PostHog', color: null },
  { slug: 'mixpanel', name: 'Mixpanel', color: '#7856FF' }, // audit:allow third-party brand colour
  { slug: 'cloudflare', name: 'Cloudflare', color: '#F38020' }, // audit:allow third-party brand colour
  { slug: 'netlify', name: 'Netlify', color: '#00C7B7' }, // audit:allow third-party brand colour
  { slug: 'docker', name: 'Docker', color: '#2496ED' }, // audit:allow third-party brand colour
  { slug: 'kubernetes', name: 'Kubernetes', color: '#326CE5' }, // audit:allow third-party brand colour
  { slug: 'postman', name: 'Postman', color: '#FF6C37' }, // audit:allow third-party brand colour
  { slug: 'typeform', name: 'Typeform', color: null },
  { slug: 'loom', name: 'Loom', color: '#625DF5' }, // audit:allow third-party brand colour
  { slug: 'box', name: 'Box', color: '#0061D5' }, // audit:allow third-party brand colour
  { slug: 'okta', name: 'Okta', color: '#007DC1' }, // audit:allow third-party brand colour
  { slug: 'todoist', name: 'Todoist', color: '#E44332' }, // audit:allow third-party brand colour
  { slug: 'evernote', name: 'Evernote', color: '#00A82D' }, // audit:allow third-party brand colour
  { slug: 'spotify', name: 'Spotify', color: '#1ED760' }, // audit:allow third-party brand colour
  { slug: 'substack', name: 'Substack', color: '#FF6719' }, // audit:allow third-party brand colour
  { slug: 'medium', name: 'Medium', color: null },
  { slug: 'producthunt', name: 'Product Hunt', color: '#DA552F' }, // audit:allow third-party brand colour
  { slug: 'hackernoon', name: 'Hacker Noon', color: '#00FE00' }, // audit:allow third-party brand colour
  { slug: 'devdotto', name: 'DEV', color: null },
  { slug: 'stackoverflow', name: 'Stack Overflow', color: '#F58025' }, // audit:allow third-party brand colour
  { slug: 'npm', name: 'npm', color: '#CB3837' }, // audit:allow third-party brand colour
  { slug: 'pypi', name: 'PyPI', color: '#3775A9' }, // audit:allow third-party brand colour
  { slug: 'circleci', name: 'CircleCI', color: '#343434' }, // audit:allow third-party brand colour
  { slug: 'githubactions', name: 'GitHub Actions', color: '#2088FF' }, // audit:allow third-party brand colour
  { slug: 'jenkins', name: 'Jenkins', color: '#D24939' }, // audit:allow third-party brand colour
  { slug: 'terraform', name: 'Terraform', color: '#844FBA' }, // audit:allow third-party brand colour
  { slug: 'ansible', name: 'Ansible', color: '#EE0000' }, // audit:allow third-party brand colour
  { slug: 'heroku', name: 'Heroku', color: '#430098' }, // audit:allow third-party brand colour
  { slug: 'render', name: 'Render', color: null },
  { slug: 'railway', name: 'Railway', color: null },
  { slug: 'digitalocean', name: 'DigitalOcean', color: '#0080FF' }, // audit:allow third-party brand colour
  { slug: 'firebase', name: 'Firebase', color: '#DD2C00' }, // audit:allow third-party brand colour
  { slug: 'planetscale', name: 'PlanetScale', color: null },
  { slug: 'prisma', name: 'Prisma', color: '#2D3748' }, // audit:allow third-party brand colour
  { slug: 'graphql', name: 'GraphQL', color: '#E10098' }, // audit:allow third-party brand colour
  { slug: 'apollographql', name: 'Apollo GraphQL', color: '#311C87' }, // audit:allow third-party brand colour
  { slug: 'brevo', name: 'Brevo', color: '#0B996E' }, // audit:allow third-party brand colour
  { slug: 'sendgrid', name: 'SendGrid', color: '#51A9E3' }, // audit:allow third-party brand colour
  { slug: 'mailgun', name: 'Mailgun', color: '#F06B66' }, // audit:allow third-party brand colour
  { slug: 'resend', name: 'Resend', color: null },
  { slug: 'paypal', name: 'PayPal', color: '#003087' }, // audit:allow third-party brand colour
  { slug: 'square', name: 'Square', color: '#3E4348' }, // audit:allow third-party brand colour
  { slug: 'wise', name: 'Wise', color: '#9FE870' }, // audit:allow third-party brand colour
  { slug: 'brex', name: 'Brex', color: null },
  { slug: 'paddle', name: 'Paddle', color: '#FDDD35' }, // audit:allow third-party brand colour
  { slug: 'lemonsqueezy', name: 'Lemon Squeezy', color: '#FFC233' }, // audit:allow third-party brand colour
  { slug: 'gumroad', name: 'Gumroad', color: '#FF90E8' }, // audit:allow third-party brand colour
  { slug: 'patreon', name: 'Patreon', color: null },
  { slug: 'framer', name: 'Framer', color: '#0055FF' }, // audit:allow third-party brand colour
  { slug: 'sketch', name: 'Sketch', color: '#F7B500' }, // audit:allow third-party brand colour
  { slug: 'dribbble', name: 'Dribbble', color: '#EA4C89' }, // audit:allow third-party brand colour
  { slug: 'behance', name: 'Behance', color: '#1769FF' }, // audit:allow third-party brand colour
  { slug: 'unsplash', name: 'Unsplash', color: null },
  { slug: 'vimeo', name: 'Vimeo', color: '#1AB7EA' }, // audit:allow third-party brand colour
  { slug: 'twitch', name: 'Twitch', color: '#9146FF' }, // audit:allow third-party brand colour
  { slug: 'soundcloud', name: 'SoundCloud', color: '#FF5500' }, // audit:allow third-party brand colour
  { slug: 'zapier', name: 'Zapier', color: '#FF4F00' }, // audit:allow third-party brand colour
  { slug: 'make', name: 'Make', color: '#6D00CC' }, // audit:allow third-party brand colour
  { slug: 'n8n', name: 'n8n', color: '#EA4B71' }, // audit:allow third-party brand colour
  { slug: 'ifttt', name: 'IFTTT', color: null },
  { slug: 'bitwarden', name: 'Bitwarden', color: '#175DDC' }, // audit:allow third-party brand colour
  { slug: '1password', name: '1Password', color: '#3B66BC' }, // audit:allow third-party brand colour
  { slug: 'auth0', name: 'Auth0', color: '#EB5424' }, // audit:allow third-party brand colour
  { slug: 'clerk', name: 'Clerk', color: '#6C47FF' }, // audit:allow third-party brand colour
  { slug: 'basecamp', name: 'Basecamp', color: null },
  { slug: 'coda', name: 'Coda', color: '#F46A54' }, // audit:allow third-party brand colour
  { slug: 'obsidian', name: 'Obsidian', color: '#7C3AED' }, // audit:allow third-party brand colour
  { slug: 'roamresearch', name: 'Roam Research', color: '#343A40' }, // audit:allow third-party brand colour
  { slug: 'zoho', name: 'Zoho', color: '#E42527' }, // audit:allow third-party brand colour
  { slug: 'helpscout', name: 'Help Scout', color: '#1292EE' }, // audit:allow third-party brand colour
  { slug: 'docsdotrs', name: 'Docs.rs', color: null },
  { slug: 'readthedocs', name: 'Read the Docs', color: '#8CA1AF' }, // audit:allow third-party brand colour
  { slug: 'gitbook', name: 'GitBook', color: '#BBDDE5' }, // audit:allow third-party brand colour
  { slug: 'mintlify', name: 'Mintlify', color: '#18E299' }, // audit:allow third-party brand colour
  { slug: 'openstreetmap', name: 'OpenStreetMap', color: '#7EBC6F' }, // audit:allow third-party brand colour
  { slug: 'googlemaps', name: 'Google Maps', color: '#4285F4' }, // audit:allow third-party brand colour
  { slug: 'mapbox', name: 'Mapbox', color: null },
  { slug: 'algolia', name: 'Algolia', color: '#003DFF' }, // audit:allow third-party brand colour
  { slug: 'elastic', name: 'Elastic', color: '#005571' }, // audit:allow third-party brand colour
  { slug: 'meilisearch', name: 'Meilisearch', color: '#FF5CAA' }, // audit:allow third-party brand colour
  { slug: 'mistral', name: 'Mistral AI', color: '#FA520F' }, // audit:allow third-party brand colour
  { slug: 'deepseek', name: 'DeepSeek', color: '#4D6BFE' }, // audit:allow third-party brand colour
  { slug: 'xai', name: 'xAI', color: null },
  { slug: 'groq', name: 'Groq', color: '#F55036' }, // audit:allow third-party brand colour
  { slug: 'cohere', name: 'Cohere', color: '#39594D' }, // audit:allow third-party brand colour
] as const;

/**
 * Brands with a full-colour logo in public/media/landing/logos/color, from
 * Composio's logo API (logos.composio.dev/api/<slug>). On hover the strip shows
 * this real logo, gradients and all, instead of the flat `color` glyph.
 *
 * Left out on purpose, so they keep the flat glyph: brands Composio has no logo
 * for, logos drawn on a black or near-black tile (they vanish on the dark band),
 * Composio's `apollo` (Apollo.io, not Apollo GraphQL), and Google Maps (its SVG
 * carries a <script>).
 */
export const FULL_COLOR_LOGOS: ReadonlySet<string> = new Set([
  'airtable', 'algolia', 'asana', 'basecamp', 'bitbucket', 'bitwarden', 'box', 'brevo',
  'calendly', 'canva', 'claude', 'clickup', 'cloudflare', 'coda', 'cohere', 'confluence',
  'databricks', 'datadog', 'deepseek', 'digitalocean', 'discord', 'dribbble', 'dropbox',
  'elastic', 'facebook', 'figma', 'firebase', 'gitlab', 'gmail', 'googleads',
  'googleanalytics', 'googlecalendar', 'googledocs', 'googledrive', 'googlegemini',
  'googlemeet', 'googlesheets', 'grafana', 'groq', 'gumroad', 'helpscout', 'heroku',
  'hubspot', 'huggingface', 'instagram', 'intercom', 'jira', 'lemonsqueezy', 'linear',
  'linkedin', 'mailchimp', 'mailgun', 'make', 'mintlify', 'miro', 'mistral', 'mongodb',
  'n8n', 'netlify', 'npm', 'openai', 'openrouter', 'pagerduty', 'paypal', 'pinterest',
  'postgresql', 'postman', 'quickbooks', 'reddit', 'salesforce', 'sendgrid', 'sentry',
  'shopify', 'slack', 'snowflake', 'soundcloud', 'spotify', 'stripe', 'telegram', 'tiktok',
  'todoist', 'trello', 'twilio', 'twitch', 'vimeo', 'webflow', 'whatsapp', 'wise', 'xero',
  'youtube', 'zoho', 'zoom',
]);
