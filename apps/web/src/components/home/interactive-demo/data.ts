import {
  Bot,
  Brain,
  Database,
  FileText,
  GitPullRequest,
  MessageSquare,
  Search,
  type LucideIcon,
} from 'lucide-react';
import { FaUsers } from 'react-icons/fa';
import type { IconType } from 'react-icons/lib';

export const favicon = (d: string) => `https://www.google.com/s2/favicons?domain=${d}&sz=128`;

export type AgentDef = {
  name: string;
  desc: string;
  icon: LucideIcon | IconType;
  trigger: string;
  model: string;
  modelDomain: string;
  runs: string;
  last: string;
  on: boolean;
};

export const AGENTS: AgentDef[] = [
  {
    name: 'kortix',
    desc: 'General knowledge worker — full tool access; codes, researches, writes and runs ops end-to-end in an isolated sandbox.',
    icon: Bot,
    trigger: 'primary',
    model: 'Claude Opus 4.8',
    modelDomain: 'anthropic.com',
    runs: '1,204',
    last: '4m ago',
    on: true,
  },
  {
    name: 'pr-bot',
    desc: 'Runs a thermo-nuclear review and stands up a one-click preview on every pull request to kortix-ai/kortix.',
    icon: GitPullRequest,
    trigger: 'webhook',
    model: 'GPT-5',
    modelDomain: 'openai.com',
    runs: '8,930',
    last: '12m ago',
    on: true,
  },
  {
    name: 'memory-reflector',
    desc: 'Reflects on recent activity and curates .kortix/memory, opening a memory CR each run.',
    icon: Brain,
    trigger: 'cron',
    model: 'Gemini 2.5 Flash',
    modelDomain: 'gemini.google.com',
    runs: '512',
    last: '2h ago',
    on: false,
  },
  {
    name: 'researcher',
    desc: 'Deep multi-source research with structured synthesis, inline citations and charts.',
    icon: Search,
    trigger: 'manual',
    model: 'Grok 4',
    modelDomain: 'x.ai',
    runs: '742',
    last: '1h ago',
    on: true,
  },
  {
    name: 'analyst',
    desc: 'Profiles the warehouse, writes performant SQL and ships a dashboard from a plain question.',
    icon: Database,
    trigger: 'manual',
    model: 'DeepSeek V3',
    modelDomain: 'deepseek.com',
    runs: '1,890',
    last: '26m ago',
    on: true,
  },
  {
    name: 'support-triage',
    desc: 'Categorizes, prioritizes and routes inbound tickets, drafting an empathetic first reply.',
    icon: MessageSquare,
    trigger: 'webhook',
    model: 'MiniMax M2',
    modelDomain: 'minimax.io',
    runs: '6,431',
    last: 'just now',
    on: true,
  },
  {
    name: 'deck-builder',
    desc: 'Turns a prompt and your latest data into board decks and polished presentations.',
    icon: FileText,
    trigger: 'manual',
    model: 'GLM-4.6',
    modelDomain: 'z.ai',
    runs: '318',
    last: '5h ago',
    on: false,
  },
  {
    name: 'sdr',
    desc: 'Enriches leads from the CRM, researches each account and drafts tailored outreach.',
    icon: FaUsers,
    trigger: 'manual',
    model: 'Qwen3 Max',
    modelDomain: 'qwen.ai',
    runs: '2,205',
    last: '38m ago',
    on: true,
  },
];

export const CORE_SKILLS: [string, string][] = [
  ['agent-browser', 'Browser automation CLI for AI agents'],
  ['kortix-executor', 'One interface to every connected integration'],
  ['kortix-memory', 'Read, write, and curate the project brain'],
  ['kortix-slack', 'Answer in Slack as a teammate'],
  ['kortix-system', 'Canonical reference for a Kortix project'],
  ['thermo-nuclear-review', 'Strict maintainability & abstraction review'],
];

export const GKW_SKILLS: [string, string][] = [
  ['account-research', 'Full picture of any company or person before outreach'],
  ['audit-support', 'SOX 404 control testing, sampling & documentation'],
  ['brand-voice', 'Document, apply & enforce brand voice across content'],
  ['call-prep', 'Get fully prepared for any sales call in minutes'],
  ['campaign-planning', 'Plan, structure & execute marketing campaigns'],
  ['canned-responses', 'Response templates for an in-house legal team'],
  ['close-management', 'Month-end close checklist, sequencing & tracking'],
  ['coding-and-data', 'Routes coding, repo work, SQL & investigation'],
  ['competitive-analysis', 'Competitive analysis for product managers'],
  ['competitive-intelligence', 'Research competitors & generate an HTML battlecard'],
  ['compliance', 'Compliance assistant for an in-house legal team'],
  ['content-creation', 'Effective marketing content across channels'],
  ['contract-review', 'Contract review assistant for legal teams'],
  ['create-an-asset', 'Build prospect decks, one-pagers & demos'],
  ['customer-research', 'Multi-source research on customers & accounts'],
  ['daily-briefing', 'A clear view of what matters most today'],
  ['deep-research', 'Deep, multi-source research agent'],
  ['design-foundations', 'Artifact-agnostic design guidance for any output'],
  ['document-review', 'Structured review, fact-check & annotation'],
  ['docx', 'Create, edit, extract & review Word documents'],
  ['domain-research', 'Free domain research & availability checking'],
  ['draft-outreach', 'Research first, then draft outreach'],
  ['elevenlabs', 'Text-to-speech, voice cloning & sound effects'],
  ['escalation', 'Decide when and how to escalate support issues'],
  ['exploration', 'Profile datasets, assess quality & find patterns'],
  ['fastapi-sdk', 'Write FastAPI code with current best practices'],
  ['feature-spec', 'Write PRDs & feature specifications'],
  ['financial-statements', 'GAAP presentation, adjustments & flux analysis'],
  ['hyper-fast-youtube-transcript', 'Pull a YouTube transcript from a URL or ID'],
  ['journal-entry-prep', 'Standard entry types & review workflows'],
  ['knowledge-management', 'Create & maintain support knowledge content'],
  ['legal-writer', 'Draft contracts, memos, briefs & demand letters'],
  ['logo-creator', 'Create logos through an iterative design process'],
  ['media', 'Media commands run via bash (ffmpeg & more)'],
  ['meeting-briefing', 'Meeting prep assistant for legal teams'],
  ['metrics-tracking', 'Define, track & act on product metrics'],
  ['nda-triage', 'NDA screening assistant for legal teams'],
  ['openalex-paper-search', 'Academic search over 240M+ scholarly works'],
  ['paper-creator', 'Scientific paper writing in LaTeX to compiled PDF'],
  ['pdf', 'Create, edit, OCR, fill & convert PDFs'],
  ['performance-analytics', 'Measure & optimize marketing performance'],
  ['pptx', 'Create, edit & validate PowerPoint decks'],
  ['presentations', 'Build & export HTML slides (1920×1080)'],
  ['reconciliation', 'GL-to-subledger & bank reconciliation methodology'],
  ['remotion', 'Programmatic video creation in React'],
  ['replicate', 'Discover, compare & run AI models on Replicate'],
  ['research-assistant', 'Deep multi-source research with synthesis'],
  ['research-report', 'Markdown research reports with citations & charts'],
  ['response-drafting', 'Professional, empathetic customer-facing replies'],
  ['risk-assessment', 'Legal risk assessment assistant'],
  ['roadmap-management', 'Roadmap planning, prioritization & comms'],
  ['sql-queries', 'Correct, performant SQL across warehouse dialects'],
  ['stakeholder-comms', 'Status updates & stakeholder management'],
  ['statistical-analysis', 'Trend analysis, outliers & hypothesis testing'],
  ['theme-factory', 'Design themes for non-website assets'],
  ['ticket-triage', 'Categorize, prioritize & route support tickets'],
  ['user-research-synthesis', 'Turn raw research into structured insight'],
  ['validation', 'Pre-delivery QA checklist & sanity checks'],
  ['variance-analysis', 'Decompose variances with waterfall methodology'],
  ['visualization', 'Chart selection & Python visualization patterns'],
  ['webapp', 'Fullstack apps on the Express/Vite/React/Drizzle stack'],
  ['website-building', 'Production-grade sites & interactive experiences'],
  ['website-building-webapp', 'App-like experiences from the website template'],
  ['whisper', 'Transcribe audio & video with Whisper'],
  ['xlsx', 'Spreadsheets, financial models & polished workbooks'],
];

export const INTEGRATIONS: [string, string, boolean][] = [
  ['github.com', 'GitHub', true],
  ['slack.com', 'Slack', true],
  ['gmail.com', 'Gmail', false],
  ['stripe.com', 'Stripe', false],
  ['notion.so', 'Notion', false],
  ['linear.app', 'Linear', false],
  ['hubspot.com', 'HubSpot', false],
  ['salesforce.com', 'Salesforce', false],
  ['drive.google.com', 'Google Drive', false],
  ['atlassian.com', 'Jira', false],
  ['figma.com', 'Figma', false],
  ['airtable.com', 'Airtable', false],
  ['shopify.com', 'Shopify', false],
  ['zoom.us', 'Zoom', false],
  ['asana.com', 'Asana', false],
  ['discord.com', 'Discord', false],
  ['twilio.com', 'Twilio', false],
  ['sendgrid.com', 'SendGrid', false],
  ['zendesk.com', 'Zendesk', false],
  ['intercom.com', 'Intercom', false],
  ['gitlab.com', 'GitLab', false],
  ['dropbox.com', 'Dropbox', false],
  ['calendly.com', 'Calendly', false],
  ['mailchimp.com', 'Mailchimp', false],
];

export const CONNECTOR_TYPES = ['App', 'MCP', 'OpenAPI', 'GraphQL', 'HTTP'];

export type Provider = {
  domain: string | null;
  name: string;
  hint: string;
  state: 'managed' | 'connected' | 'connect';
};

export const PROVIDERS: Provider[] = [
  {
    domain: null,
    name: 'Kortix Gateway',
    hint: 'Managed routing — injected into every sandbox',
    state: 'managed',
  },
  {
    domain: 'anthropic.com',
    name: 'Anthropic',
    hint: 'Claude — Opus, Sonnet, Haiku',
    state: 'connected',
  },
  { domain: 'openai.com', name: 'OpenAI', hint: 'GPT-5, GPT-4o, o-series', state: 'connect' },
  { domain: 'ai.google.dev', name: 'Google', hint: 'Gemini 2.5 Pro, Flash', state: 'connect' },
  {
    domain: 'groq.com',
    name: 'Groq',
    hint: 'Fast inference — Llama, Mixtral, Kimi',
    state: 'connect',
  },
  { domain: 'x.ai', name: 'xAI', hint: 'Grok', state: 'connect' },
  { domain: 'deepseek.com', name: 'DeepSeek', hint: 'DeepSeek V3, R1', state: 'connect' },
  { domain: 'mistral.ai', name: 'Mistral', hint: 'Mistral Large, Codestral', state: 'connect' },
  {
    domain: 'openrouter.ai',
    name: 'OpenRouter',
    hint: 'Routes across many providers',
    state: 'connect',
  },
  { domain: 'cerebras.ai', name: 'Cerebras', hint: 'Very fast — Llama, Qwen', state: 'connect' },
  { domain: 'together.ai', name: 'Together', hint: 'Open models hosted', state: 'connect' },
  { domain: 'fireworks.ai', name: 'Fireworks', hint: 'Open models hosted', state: 'connect' },
  { domain: 'perplexity.ai', name: 'Perplexity', hint: 'Web-grounded models', state: 'connect' },
  {
    domain: 'aws.amazon.com',
    name: 'Amazon Bedrock',
    hint: 'Claude, Llama, Titan',
    state: 'connect',
  },
  {
    domain: 'azure.microsoft.com',
    name: 'Azure OpenAI',
    hint: 'Azure-hosted OpenAI',
    state: 'connect',
  },
  { domain: 'cohere.com', name: 'Cohere', hint: 'Command R', state: 'connect' },
  { domain: 'huggingface.co', name: 'Hugging Face', hint: 'Inference endpoints', state: 'connect' },
  { domain: 'nvidia.com', name: 'NVIDIA NIM', hint: 'NIM microservices', state: 'connect' },
];

export type ScheduleJob = { name: string; cron: string; when: string; next: string; on: boolean };

export const INITIAL_JOBS: ScheduleJob[] = [
  { name: 'memory-reflector', cron: '0 */6 * * *', when: 'every 6 hours', next: 'in 2h', on: true },
  { name: 'Daily briefing', cron: '0 8 * * *', when: 'every day · 08:00', next: 'in 6h', on: true },
  {
    name: 'Weekly PR digest',
    cron: '0 7 * * 1',
    when: 'every Mon · 07:00',
    next: 'in 3d',
    on: true,
  },
  {
    name: 'Quarterly cleanup',
    cron: '0 6 1 */3 *',
    when: 'every 90 days',
    next: 'in 21d',
    on: false,
  },
];

export type Member = {
  email: string;
  name: string;
  role: 'Owner' | 'Admin' | 'Member';
  last: string;
};
export type Secret = {
  name: string;
  masked: string;
  domain: string;
  rotated: string;
  agents: number;
};
export type Policy = { domain: string; name: string; allow: number; ask: number; block: number };

export const MEMBERS: Member[] = [
  { email: 'marko@kortix.com', name: 'marko', role: 'Owner', last: 'active now' },
  { email: 'dom@kortix.com', name: 'Dom Williams', role: 'Admin', last: '2h ago' },
  { email: 'sara@kortix.com', name: 'Sara Khan', role: 'Member', last: '1d ago' },
];

export const SECRETS: Secret[] = [
  {
    name: 'ANTHROPIC_API_KEY',
    masked: 'sk-ant-••••4f2a',
    domain: 'anthropic.com',
    rotated: '12d ago',
    agents: 6,
  },
  {
    name: 'OPENAI_API_KEY',
    masked: 'sk-••••9c10',
    domain: 'openai.com',
    rotated: '30d ago',
    agents: 3,
  },
  {
    name: 'SLACK_BOT_TOKEN',
    masked: 'xoxb-••••7d3',
    domain: 'slack.com',
    rotated: '8d ago',
    agents: 2,
  },
  {
    name: 'GITHUB_TOKEN',
    masked: 'ghp_••••2b8e',
    domain: 'github.com',
    rotated: '3d ago',
    agents: 1,
  },
  {
    name: 'STRIPE_API_KEY',
    masked: 'sk_live_••••a91c',
    domain: 'stripe.com',
    rotated: '45d ago',
    agents: 1,
  },
];

export const POLICIES: Policy[] = [
  { domain: 'github.com', name: 'GitHub', allow: 14, ask: 3, block: 1 },
  { domain: 'slack.com', name: 'Slack', allow: 9, ask: 1, block: 0 },
  { domain: 'stripe.com', name: 'Stripe', allow: 4, ask: 6, block: 2 },
];
