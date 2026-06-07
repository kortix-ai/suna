'use client';

import { useAuth } from '@/components/AuthProvider';
import { CodeWindow } from '@/components/home/code-window';
import { InteractiveDemo } from '@/components/home/interactive-demo';
import { Reveal } from '@/components/home/reveal';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { AnimatedThinkingText } from '@/components/ui/animated-thinking-text';
import { Badge } from '@/components/ui/badge';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { KORTIX_BULLET_GRADIENT, KortixAsterisk } from '@/components/ui/kortix-asterisk';
import { Button } from '@/components/ui/marketing/button';
import KortixGrid from '@/components/ui/marketing/gridder';
import { Textarea } from '@/components/ui/textarea';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { Icon } from '@/features/icon/icon';
import { useGitHubStars } from '@/hooks/utils/use-github-stars';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { cn } from '@/lib/utils';
import {
  Activity,
  AtSign,
  Box,
  Building2,
  Code2,
  FileText,
  GitBranch,
  MoreHorizontal,
  Plus,
  Server,
  Smile,
  TrendingUp,
} from 'lucide-react';
import {
  AnimatePresence,
  motion,
  useInView,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
} from 'motion/react';
import Image from 'next/image';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FaUsers } from 'react-icons/fa';
import { FiBookmark } from 'react-icons/fi';
import { HiOutlineDotsHorizontal } from 'react-icons/hi';
import { HiArrowRight, HiMiniSparkles } from 'react-icons/hi2';
import { MdShield } from 'react-icons/md';
import { PiBellFill, PiChatCircleDotsFill, PiChatsCircleFill, PiFilesFill } from 'react-icons/pi';
import { TbChevronUpRight } from 'react-icons/tb';

const DEMO_URL = '/contact';
// Generated copy variation. UI copied from apps/web/src/app/(home)/page.tsx; edit content only.
const LANDING_COPY = {
  useCasesEyebrow: 'Internal agents',
  useCasesTitle: 'Start with one useful agent.',
  useCasesDescription: 'Each is a Kortix project you can configure, deploy, and own.',
  useCasesLearnMore: 'See how built',
  useCaseDemos: {
    triageCustomerSignals: {
      tabTitle: 'Support agent',
      tabDescription: 'Answers from docs and order tools.',
      eyebrow: 'Internal agent',
      title: 'A support agent that closes tickets.',
      description: 'It reads the ticket, drafts a reply from your docs, and waits for sign-off.',
      log: [
        'Pulled ticket + customer history',
        'Drafted reply from docs',
        'Flagged refund for approval',
        'Sent, logged to audit trail',
      ],
    },
    shipBacklogTickets: {
      tabTitle: 'Engineering agent',
      tabDescription: 'Reviews PRs and opens fixes.',
      eyebrow: 'Internal agent',
      title: 'An engineering agent that ships fixes.',
      description: 'It reviews the PR, opens a fix branch, and submits a change request.',
      log: [
        'Reviewed diff in sandbox',
        'Reproduced the bug',
        'Opened fix branch',
        'Submitted change request',
      ],
    },
    fillThePipeline: {
      tabTitle: 'Research agent',
      tabDescription: 'Briefs teams from trusted sources.',
      eyebrow: 'Internal agent',
      title: 'A research agent that briefs your team.',
      description: 'It gathers from trusted sources and posts a brief to Slack before the call.',
      log: [
        'Gathered from approved sources',
        'Cross-checked the facts',
        'Wrote the brief',
        'Posted to Slack',
      ],
    },
    closeTheBooks: {
      tabTitle: 'Finance agent',
      tabDescription: 'Reconciles and flags exceptions.',
      eyebrow: 'Internal agent',
      title: 'A finance agent that closes the month.',
      description: 'It reconciles transactions, flags exceptions, and waits for your approval.',
      log: ['Matched transactions', 'Flagged 3 exceptions', 'Drafted summary', 'Held for sign-off'],
    },
    briefToCampaign: {
      tabTitle: 'Marketing agent',
      tabDescription: 'Turns briefs into drafts.',
      eyebrow: 'Internal agent',
      title: 'A marketing agent that runs the brief.',
      description: 'It turns a brief into drafts, then routes them for review.',
      log: ['Read the brief', 'Drafted the assets', 'Checked brand rules', 'Routed for review'],
    },
    runTheBackOffice: {
      tabTitle: 'Operations agent',
      tabDescription: 'Runs back-office SOPs.',
      eyebrow: 'Internal agent',
      title: 'An operations agent that runs the SOP.',
      description: 'It executes the workflow step by step, pausing at each approval gate.',
      log: [
        'Loaded the SOP',
        'Ran each step in sandbox',
        'Paused at approval gate',
        'Closed the task',
      ],
    },
  },
  line138JsxTextTheAiCommandCenter: 'The AI command center',
  line139JsxTextForYourCompany: 'for your company',
  line142JsxTextRunYourCompanyOnAiEveryAgentTrigger:
    'Run your company on AI. Every agent, trigger, integration, and memory your teams need — in one place you control.',
  line146JsxTextGetStarted: 'Get started',
  line149JsxTextTalkToSales: 'See GitHub',
  line163JsxTextConnectsToThe: 'Connects to the',
  line163JsxTextText3000Apps: '3,000+ Apps',
  line163JsxTextYourCompanyAlreadyRunsOn: 'your company already runs on',
  line193JsxTextLiveAcrossYourCompanyInWeeks: 'Live across your company in weeks.',
  line196JsxTextNoRipAndReplaceStandUpYourFirst:
    'No rip-and-replace. Stand up your first agent in an afternoon, then scale department by department.',
  line225JsxTextOpenAmpCodeNative: 'Open & code-native',
  line227JsxTextYourWholeCompanyAsCode: 'Your whole company, as code.',
  line230JsxTextEveryAgentSkillTriggerAndPolicyIsPlain:
    'Every agent, skill, trigger, and policy is plain code in a git repo — diff it, review it, roll it back. Built on the open',
  line230JsxTextAgentRuntimeSelfHostAnywhereNoBlackBox:
    'agent runtime. Self-host anywhere. No black box, no lock-in.',
  line267JsxTextStarsOnGithub: 'stars on GitHub',
  line269JsxTextALeadingOpenSourceAiWorkspace: 'A leading open-source AI workspace.',
  line284JsxTextSecureEnoughToRunTheWholeCompany: 'Secure enough to run the whole company.',
  line287JsxTextFineGrainedControlOverWhoAndWhichAgent:
    'Fine-grained control over who — and which agent — can do what, with hard isolation around every single run.',
  line314JsxTextTalkToSales: 'Talk to sales',
  line317JsxTextSeeHowItWorks: 'See how it works',
  line329JsxTextGetStarted: 'Get started',
  line331JsxTextGiveYourCompanyAWorkforce: 'Ship your first internal agent.',
  line334JsxTextFreeToSelfHostManagedCloudFrom20: [
    'Free to self-host',
    'Managed cloud from $20',
    'Bring your own coding agent',
  ],
  line337JsxTextGetStarted: 'Start building',
  line338JsxTextTalkToSales: 'See GitHub',
  line339JsxTextSeePricing: 'See pricing',
  line342JsxTextOpenSourceSsoRbacAmpOnPremNo: 'Open source · SSO, RBAC & on-prem · No lock-in',
  line356JsxTextGetStarted: 'Get started',
  line59JsxTextTheAiCommandCenter: 'The AI command center',
  line60JsxTextForYourCompany: 'for your company',
  line63JsxTextRunYourCompanyOnAiEveryAgentTrigger:
    'Run your company on AI. Every agent, trigger, integration, and memory your teams need — in one place you control.',
  line67JsxTextGetStarted: 'Get started',
  line70JsxTextTalkToSales: 'Talk to sales',
  line84JsxTextConnectsToThe: 'Connects to the',
  line84JsxTextText3000Tools: '3,000+ tools',
  line84JsxTextYourCompanyAlreadyRunsOn: 'your company already runs on',
  line127JsxTextLiveAcrossYourCompanyInWeeks: 'Live across your company in weeks.',
  line130JsxTextNoRipAndReplaceStandUpYourFirst:
    'No rip-and-replace. Stand up your first agent in an afternoon, then scale department by department.',
  line159JsxTextOpenAmpCodeNative: 'Open & code-native',
  line161JsxTextYourWholeCompanyAsCode: 'Your whole company, as code.',
  line164JsxTextEveryAgentSkillTriggerAndPolicyIsPlain:
    'Every agent, skill, trigger, and policy is plain code in a git repo — diff it, review it, roll it back. Built on the open',
  line164JsxTextAgentRuntimeSelfHostAnywhereNoBlackBox:
    'agent runtime. Self-host anywhere. No black box, no lock-in.',
  line201JsxTextStarsOnGithub: 'stars on GitHub',
  line203JsxTextALeadingOpenSourceAiWorkspace: 'A leading open-source AI workspace.',
  line218JsxTextSecureEnoughToRunTheWholeCompany: 'Secure enough to run the whole company.',
  line221JsxTextFineGrainedControlOverWhoAndWhichAgent:
    'Fine-grained control over who — and which agent — can do what, with hard isolation around every single run.',
  line248JsxTextTalkToSales: 'Talk to sales',
  line251JsxTextSeeHowItWorks: 'See how it works',
  line263JsxTextGetStarted: 'Get started',
  line265JsxTextGiveYourCompanyAWorkforce: 'Give your company a workforce.',
  line268JsxTextFreeToSelfHostManagedCloudFrom20:
    'Free to self-host. Managed cloud from $20 / seat + usage. Spin up your first agent today — or have us map it to your workflows in a live demo.',
  line271JsxTextGetStarted: 'Get started',
  line272JsxTextTalkToSales: 'Talk to sales',
  line273JsxTextSeePricing: 'See pricing',
  line276JsxTextOpenSourceSsoRbacAmpOnPremNo: 'Open source · SSO, RBAC & on-prem · No lock-in',
  line290JsxTextGetStarted: 'Get started',
  line138JsxTextTheAICommandCenter: 'The AI command center',
  line142JsxTextRunYourCompanyOnAIEveryAgentTrigger:
    'Run your company on AI. Every agent, trigger, integration, and memory your teams need — in one place you control.',
  line163JsxText3000Apps: '3,000+ Apps',
  line225JsxTextOpenCodeNative: 'Open & code-native',
  line267JsxTextStarsOnGitHub: 'stars on GitHub',
  line269JsxTextALeadingOpenSourceAIWorkspace: 'An open source platform for internal agents.',
  line342JsxTextOpenSourceSSORBACOnPremNoLock: 'Open source · SSO, RBAC & on-prem · No lock-in',
  heroCommandCenter: 'Turn your coding agent',
  heroAiWorkforce: 'into an internal agent.',
  heroDescription:
    'Run kortix init, choose Claude Code, Codex, or opencode, configure the agent, then deploy it to Slack.',
  startBuildingCta: 'Start building',
  workLoopEyebrow: 'How it works',
  workLoopTitle: 'Code. Deploy. Connect Slack.',
  workLoopDescription:
    'A Kortix project packages the agent config, persona, skills, tools, and runtime.',
  workLoopFinanceTitle: 'Support agent',
  workLoopFinancePrompt: 'Answer this ticket from our docs and order history.',
  workLoopEngineeringTitle: 'Engineering agent',
  workLoopEngineeringPrompt: 'Review this PR and open a fix branch.',
  workLoopSalesTitle: 'Research agent',
  workLoopSalesPrompt: 'Brief the team on this account before the call.',
  workLoopAskLabel: 'kortix init',
  workLoopWorkLabel: 'Configure',
  workLoopReviewLabel: 'kortix deploy',
  workLoopDoneLabel: 'Live in Slack',
  workLoopFinanceAsk: 'Scaffold a project from the coding agent you already use.',
  workLoopFinanceWork: 'Set the docs, order tools, tone, approvals, and support workflow.',
  workLoopFinanceReview: 'Push the project to a sandboxed cloud runtime.',
  workLoopFinanceDone: 'The support agent answers in Slack with review and audit trail.',
  workLoopEngineeringAsk: 'Start from your local coding-agent setup.',
  workLoopEngineeringWork: 'Add repo access, review rules, tests, and branch permissions.',
  workLoopEngineeringReview: 'Deploy the agent into an isolated runtime.',
  workLoopEngineeringDone: 'It reviews PRs, opens fix branches, and waits for sign-off.',
  workLoopSalesAsk: 'Create a project for account research.',
  workLoopSalesWork: 'Wire approved sources, CRM context, and briefing format.',
  workLoopSalesReview: 'Deploy the research agent to your team.',
  workLoopSalesDone: 'It posts verified account briefs before calls.',
  splitEyebrow: 'Two ways in',
  splitTitle: 'Start solo or roll out.',
  splitCompaniesEyebrow: 'For teams',
  splitCompaniesTitle: 'Agents your team can use.',
  splitCompaniesBody: 'Reach every agent from Slack, with approvals and an audit trail.',
  splitCompaniesPointOne: 'Start agents from Slack',
  splitCompaniesPointTwo: 'Human approval before agents act',
  splitCompaniesPointThree: 'Data and config stay yours',
  splitBuildersEyebrow: 'For builders',
  splitBuildersTitle: 'Ship from the CLI.',
  splitBuildersBody:
    'Use the coding agent you already pay for. Run kortix init, configure, deploy.',
  splitBuildersPointOne: 'Bring Claude Code, Codex, or opencode',
  splitBuildersPointTwo: 'Config, skills, and tools as code',
  splitBuildersPointThree: 'Self-host or run on cloud',
  differentScreenEyebrow: 'Open platform',
  differentScreenSectionTitle: 'Built on open standards.',
  differentScreenSectionDescription:
    'Your agent is config, prompts, skills, and tools, portable across cloud, self-host, or marketplace.',
  companyAsCodeEyebrow: 'Just code',
  companyAsCodeTitle: 'Your agent is just code.',
  companyAsCodeDescription:
    'Skills, persona, tools, and runtime live in one project you can read, diff, and own.',
  companyAsCodeBulletConfig: 'Agent config in one kortix.toml',
  companyAsCodeBulletAgents: 'Skills, persona, and tools as files',
  companyAsCodeBulletGit: 'Every change versioned and diffable',
  companyAsCodeBulletSelfHost: 'Self-host or run on cloud',
  integrationsEyebrow: 'Connect',
  integrationsTitlePrefix: 'Deploy to Slack,',
  integrationsTitle: 'connect everything else.',
  integrationsDescription:
    'Agents start where your team already works, with scoped access to the tools they need.',
  enterpriseEyebrow: 'Built to ship safely',
  enterpriseTitle: 'Safe enough to deploy.',
  enterpriseDescription:
    'Isolation, approvals, and an audit trail so an internal agent can do real work.',
  enterpriseScopedTitle: 'Scoped access',
  enterpriseScopedDescription: 'Per-resource permissions for every agent and person.',
  enterpriseApprovalsTitle: 'Human approval',
  enterpriseApprovalsDescription: 'Agents pause for sign-off before they act.',
  enterpriseIsolationTitle: 'Sandbox isolation',
  enterpriseIsolationDescription: 'Each session runs in its own isolated machine.',
  enterpriseDeployTitle: 'Deploy anywhere',
  enterpriseDeployDescription: 'Cloud, self-host, VPC, or air-gapped.',
  statIntegrations: 'Integrations, out of the box',
  statCommandCenter: 'Command center for everything',
  statAlwaysOn: 'Agents that never clock out',
  statOpenSelfHostable: 'Open & self-hostable',
  splitDescription: 'Deploy your first agent today. Bring your team when you are ready.',
  workforceMapEyebrow: 'Open platform',
  workforceMapTitle: 'Build once. Run anywhere.',
  workforceMapDescription:
    'Build internal agents once and run them on cloud, your own infra, or an open marketplace.',
  workforceMapAgentsTitle: 'Code-based agents',
  workforceMapAgentsDesc: 'Persona, skills, and tools as files.',
  workforceMapAutomationsTitle: 'Portable runtime',
  workforceMapAutomationsDesc: 'Run on cloud, self-host, or VPC.',
  workforceMapIntegrationsTitle: 'Connect to Slack',
  workforceMapIntegrationsDesc: 'Reach your team where they work.',
  workforceMapMemoryTitle: 'Marketplace-ready',
  workforceMapMemoryDesc: 'Share templates without locking users in.',
  workforceMapPillCommunication: 'kortix init',
  workforceMapPillDocs: 'Configure',
  workforceMapPillCode: 'kortix deploy',
  workforceMapPillCrm: 'Slack',
  workforceMapPillData: 'Data',
} as const;

const GITHUB_URL = 'https://github.com/kortix-ai/suna';

const favicon = (d: string) => `https://www.google.com/s2/favicons?domain=${d}&sz=128`;

const INTEGRATIONS = [
  'gmail.com',
  'slack.com',
  'discord.com',
  'zoom.us',
  'microsoft.com',
  'telegram.org',
  'whatsapp.com',
  'twilio.com',
  'sendgrid.com',
  'mailgun.com',
  'intercom.com',
  'front.com',
  'loom.com',
  'webex.com',
  'ringcentral.com',
  'notion.so',
  'airtable.com',
  'asana.com',
  'monday.com',
  'clickup.com',
  'trello.com',
  'todoist.com',
  'evernote.com',
  'coda.io',
  'atlassian.com',
  'jira.com',
  'basecamp.com',
  'miro.com',
  'figma.com',
  'canva.com',
  'smartsheet.com',
  'wrike.com',
  'dropbox.com',
  'box.com',
  'drive.google.com',
  'onedrive.live.com',
  'wetransfer.com',
  'github.com',
  'gitlab.com',
  'bitbucket.org',
  'vercel.com',
  'netlify.com',
  'heroku.com',
  'aws.amazon.com',
  'cloud.google.com',
  'azure.microsoft.com',
  'digitalocean.com',
  'cloudflare.com',
  'docker.com',
  'sentry.io',
  'datadoghq.com',
  'pagerduty.com',
  'circleci.com',
  'npmjs.com',
  'postman.com',
  'mongodb.com',
  'redis.io',
  'supabase.com',
  'planetscale.com',
  'snowflake.com',
  'databricks.com',
  'jenkins.io',
  'linear.app',
  'salesforce.com',
  'hubspot.com',
  'pipedrive.com',
  'zoho.com',
  'close.com',
  'outreach.io',
  'salesloft.com',
  'gong.io',
  'apollo.io',
  'clearbit.com',
  'zoominfo.com',
  'copper.com',
  'mailchimp.com',
  'klaviyo.com',
  'marketo.com',
  'activecampaign.com',
  'convertkit.com',
  'hootsuite.com',
  'buffer.com',
  'sproutsocial.com',
  'semrush.com',
  'ahrefs.com',
  'mixpanel.com',
  'amplitude.com',
  'segment.com',
  'hotjar.com',
  'stripe.com',
  'paypal.com',
  'squareup.com',
  'quickbooks.intuit.com',
  'xero.com',
  'brex.com',
  'ramp.com',
  'wise.com',
  'plaid.com',
  'chargebee.com',
  'recurly.com',
  'paddle.com',
  'bill.com',
  'zendesk.com',
  'freshdesk.com',
  'helpscout.com',
  'gorgias.com',
  'kustomer.com',
  'workday.com',
  'bamboohr.com',
  'gusto.com',
  'rippling.com',
  'deel.com',
  'lever.co',
  'greenhouse.io',
  'ashbyhq.com',
  'shopify.com',
  'woocommerce.com',
  'bigcommerce.com',
  'squarespace.com',
  'wix.com',
  'webflow.com',
  // 'magento.com',
  'tableau.com',
  'looker.com',
  'metabase.com',
  'fivetran.com',
  'getdbt.com',
  'hex.tech',
  'typeform.com',
  'surveymonkey.com',
  'jotform.com',
  'tally.so',
  'calendly.com',
  'cal.com',
  'zapier.com',
  'make.com',
  'ifttt.com',
  'retool.com',
  'docusign.com',
  'pandadoc.com',
  'linkedin.com',
  'x.com',
  'facebook.com',
  'instagram.com',
  'youtube.com',
  'tiktok.com',
  'reddit.com',
  'pinterest.com',
  'twitch.tv',
  'openai.com',
  'anthropic.com',
  'huggingface.co',
  'perplexity.ai',
  'mistral.ai',
  'cohere.com',
  'replicate.com',
  'elevenlabs.io',
];

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
      {children}
    </span>
  );
}

const MARQUEE_PX_PER_SEC = 18;

function LogoMarquee({ items, reverse = false }: { items: string[]; reverse?: boolean }) {
  const duration = (items.length * 60) / MARQUEE_PX_PER_SEC;
  const loop = [...items, ...items, ...items];
  return (
    <div className="relative overflow-hidden">
      <motion.div
        className="flex w-max"
        animate={{ x: reverse ? ['-50%', '0%'] : ['0%', '-50%'] }}
        transition={{ duration, repeat: Infinity, ease: 'linear' }}
      >
        {loop.map((d, i) => (
          <span
            key={`${d}-${i}`}
            className="bg-card mr-3 flex h-12 shrink-0 items-center justify-center gap-4 rounded px-4"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={favicon(d)}
              alt=""
              width={22}
              height={22}
              loading="lazy"
              decoding="async"
              className="size-6"
            />
            <span className="text-muted-foreground text-sm font-medium tracking-wider capitalize">
              {d.split('.')[0]}
            </span>
          </span>
        ))}
      </motion.div>
    </div>
  );
}

const INTEGRATIONS_MID = Math.ceil(INTEGRATIONS.length / 3);
const INTEGRATIONS_ROW_1 = INTEGRATIONS.slice(0, INTEGRATIONS_MID);
const INTEGRATIONS_ROW_2 = INTEGRATIONS.slice(INTEGRATIONS_MID, INTEGRATIONS_MID * 2);
const INTEGRATIONS_ROW_3 = INTEGRATIONS.slice(INTEGRATIONS_MID);

const WORK_LOOPS = [
  {
    id: 'finance',
    titleKey: 'workLoopFinanceTitle',
    promptKey: 'workLoopFinancePrompt',
    agent: 'support-agent',
    steps: [
      ['workLoopAskLabel', 'workLoopFinanceAsk'],
      ['workLoopWorkLabel', 'workLoopFinanceWork'],
      ['workLoopReviewLabel', 'workLoopFinanceReview'],
      ['workLoopDoneLabel', 'workLoopFinanceDone'],
    ],
  },
  {
    id: 'engineering',
    titleKey: 'workLoopEngineeringTitle',
    promptKey: 'workLoopEngineeringPrompt',
    agent: 'engineering-agent',
    steps: [
      ['workLoopAskLabel', 'workLoopEngineeringAsk'],
      ['workLoopWorkLabel', 'workLoopEngineeringWork'],
      ['workLoopReviewLabel', 'workLoopEngineeringReview'],
      ['workLoopDoneLabel', 'workLoopEngineeringDone'],
    ],
  },
  {
    id: 'sales',
    titleKey: 'workLoopSalesTitle',
    promptKey: 'workLoopSalesPrompt',
    agent: 'research-agent',
    steps: [
      ['workLoopAskLabel', 'workLoopSalesAsk'],
      ['workLoopWorkLabel', 'workLoopSalesWork'],
      ['workLoopReviewLabel', 'workLoopSalesReview'],
      ['workLoopDoneLabel', 'workLoopSalesDone'],
    ],
  },
] as const;

const USE_CASE_DEMOS = [
  { id: 'triageCustomerSignals', icon: Activity, slug: 'customer-support-ticket-triage' },
  { id: 'shipBacklogTickets', icon: GitBranch, slug: 'software-and-saas-bug-triage' },
  { id: 'fillThePipeline', icon: TrendingUp, slug: 'sales-and-revenue-lead-research' },
  { id: 'closeTheBooks', icon: FileText, slug: 'finance-and-accounting-reconciliation' },
  { id: 'briefToCampaign', icon: HiMiniSparkles, slug: 'marketing-and-creative-content-engine' },
  { id: 'runTheBackOffice', icon: Box, slug: 'operations-and-supply-chain-sop-automation' },
] as const;

type UseCaseDemoCopy = {
  tabTitle: string;
  tabDescription: string;
  eyebrow: string;
  title: string;
  description: string;
  log: string[];
};

const SPLIT_PATHS = [
  {
    icon: Building2,
    eyebrowKey: 'splitCompaniesEyebrow',
    titleKey: 'splitCompaniesTitle',
    bodyKey: 'splitCompaniesBody',
    points: ['splitCompaniesPointOne', 'splitCompaniesPointTwo', 'splitCompaniesPointThree'],
    ctaKey: 'line149JsxTextTalkToSales',
    href: DEMO_URL,
    variant: 'secondary',
  },
  {
    icon: Code2,
    eyebrowKey: 'splitBuildersEyebrow',
    titleKey: 'splitBuildersTitle',
    bodyKey: 'splitBuildersBody',
    points: ['splitBuildersPointOne', 'splitBuildersPointTwo', 'splitBuildersPointThree'],
    ctaKey: 'startBuildingCta',
    href: '/auth',
    variant: 'default',
  },
] as const;

const WORKFORCE_MAP_CAPABILITIES = [
  {
    icon: HiMiniSparkles,
    titleKey: 'workforceMapAgentsTitle',
    descKey: 'workforceMapAgentsDesc',
  },
  {
    icon: GitBranch,
    titleKey: 'workforceMapAutomationsTitle',
    descKey: 'workforceMapAutomationsDesc',
  },
  {
    icon: Box,
    titleKey: 'workforceMapIntegrationsTitle',
    descKey: 'workforceMapIntegrationsDesc',
  },
  {
    icon: Server,
    titleKey: 'workforceMapMemoryTitle',
    descKey: 'workforceMapMemoryDesc',
  },
] as const;

const WORKFORCE_MAP_DOMAINS = [
  { icon: PiChatCircleDotsFill, labelKey: 'workforceMapPillCommunication' },
  { icon: FileText, labelKey: 'workforceMapPillDocs' },
  { icon: Code2, labelKey: 'workforceMapPillCode' },
  { icon: Building2, labelKey: 'workforceMapPillCrm' },
] as const;

function LogoMarqueeRows() {
  return (
    <div className="relative space-y-3 mask-x-from-80%">
      <LogoMarquee items={INTEGRATIONS_ROW_1} />
      <LogoMarquee items={INTEGRATIONS_ROW_2} reverse />
      <LogoMarquee items={INTEGRATIONS_ROW_3} />
    </div>
  );
}

const MORNING_BRIEF_MARKDOWN = `##### Here's your morning brief:

- **Stripe revenue:** +$3,482
- **3 enterprise leads replied**
- **2 customers reported onboarding friction**
- **Production uptime:** 99.98%
- **GitHub:** 14 PRs merged
- **Slack:** 3 discussions need your input

##### I've prepared a detailed report if you'd like to review it.`;

const CHAT_THINKING_MS = 3000;
const CHAT_STREAM_CHARS_PER_TICK = 6;
const CHAT_STREAM_TICK_MS = 28;

function ChatMorningBriefReply() {
  const [phase, setPhase] = useState<'thinking' | 'streaming' | 'done'>('thinking');
  const [streamedContent, setStreamedContent] = useState('');

  useEffect(() => {
    const thinkingTimer = window.setTimeout(() => {
      setPhase('streaming');
    }, CHAT_THINKING_MS);

    return () => window.clearTimeout(thinkingTimer);
  }, []);

  useEffect(() => {
    if (phase !== 'streaming') return;

    let index = 0;

    const interval = window.setInterval(() => {
      index = Math.min(index + CHAT_STREAM_CHARS_PER_TICK, MORNING_BRIEF_MARKDOWN.length);
      setStreamedContent(MORNING_BRIEF_MARKDOWN.slice(0, index));

      if (index >= MORNING_BRIEF_MARKDOWN.length) {
        window.clearInterval(interval);
        setPhase('done');
      }
    }, CHAT_STREAM_TICK_MS);

    return () => window.clearInterval(interval);
  }, [phase]);

  if (phase === 'thinking') {
    return (
      <div className="flex items-center gap-1.5 py-0.5">
        <span className="relative flex size-2.5 shrink-0">
          <span className="bg-muted-foreground/30 absolute inline-flex h-full w-full animate-ping rounded-full" />
          <span className="bg-muted-foreground/50 relative inline-flex size-2.5 rounded-full" />
        </span>
        <AnimatedThinkingText
          statusText="Gathering overnight updates..."
          className="text-muted-foreground text-xs"
        />
      </div>
    );
  }

  return (
    <UnifiedMarkdown
      content={streamedContent}
      isStreaming={phase === 'streaming'}
      className="prose prose-sm [&_*]:text-muted-foreground max-w-none space-y-0 text-xs font-medium [&_*]:text-xs [&_*]:font-medium [&_div]:space-y-0 [&_h5]:font-medium [&_ul]:ml-0"
    />
  );
}

export default function LandingV1() {
  const [activeLoopId, setActiveLoopId] = useState<(typeof WORK_LOOPS)[number]['id']>('finance');
  const [activeUseCaseId, setActiveUseCaseId] =
    useState<(typeof USE_CASE_DEMOS)[number]['id']>('triageCustomerSignals');
  const reduceMotion = useReducedMotion();
  const { user } = useAuth();
  const { formattedStars } = useGitHubStars('kortix-ai', 'kortix');
  const activeLoop = WORK_LOOPS.find((loop) => loop.id === activeLoopId) ?? WORK_LOOPS[0];
  const tHardcodedUi = {
    raw: (path: string): any => {
      const key = path.replace(/^appHomePage\./, '');
      return LANDING_COPY[key as keyof typeof LANDING_COPY] ?? key;
    },
  };
  const tHome = useCallback(
    (key: string): any => LANDING_COPY[key as keyof typeof LANDING_COPY],
    [],
  );
  const useCaseCopy = tHome('useCaseDemos') as Record<string, UseCaseDemoCopy>;
  const activeUseCase =
    USE_CASE_DEMOS.find((demo) => demo.id === activeUseCaseId) ?? USE_CASE_DEMOS[0];
  const activeUseCaseCopy = useCaseCopy[activeUseCase.id];

  const handleLaunch = useCallback(() => {
    trackCtaSignup();
    window.location.href = user ? '/projects' : '/auth';
  }, [user]);

  const screenCardsRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: screenCardsRef,
    offset: ['center end', 'start center'],
  });

  const STACK_STEP = 10;
  const SPREAD = 240;
  const smoothProgress = useSpring(scrollYProgress, {
    stiffness: 100,
    damping: 30,
    mass: 1,
    restDelta: 0.001,
  });
  const mobileCardX = useTransform(smoothProgress, [0, 1], [SPREAD + STACK_STEP * 2, 0]);
  const middleCardX = useTransform(smoothProgress, [0, 1], [SPREAD - STACK_STEP * 2, 0]);
  const desktopCardX = useTransform(smoothProgress, [0, 1], [-SPREAD, 0]);

  const chatDemoDesktopRef = useRef<HTMLDivElement>(null);
  const chatDemoMobileRef = useRef<HTMLDivElement>(null);
  const isChatDemoDesktopInView = useInView(chatDemoDesktopRef, { once: true, amount: 0.4 });
  const isChatDemoMobileInView = useInView(chatDemoMobileRef, { once: true, amount: 0.4 });
  const isChatDemoInView = isChatDemoDesktopInView || isChatDemoMobileInView;
  const [visibleChatMessages, setVisibleChatMessages] = useState(0);

  useEffect(() => {
    if (!isChatDemoInView) return;

    setVisibleChatMessages(1);
    const secondMessageTimer = window.setTimeout(() => setVisibleChatMessages(2), 2000);
    const thirdMessageTimer = window.setTimeout(() => setVisibleChatMessages(3), 4000);

    return () => {
      window.clearTimeout(secondMessageTimer);
      window.clearTimeout(thirdMessageTimer);
    };
  }, [isChatDemoInView]);

  const PATHS = [
    'M0.999991 1.00002C0.999992 25.9576 458 1.00001 458 53',
    'M326 1.00001C326 25.9575 471 1.00001 471 53',
    'M955 1.00002C955 25.9576 498 1.00001 498 53',
    'M630 1.00001C630 25.9575 485 1.00001 485 53',
  ];

  return (
    <>
      <div className="bg-background relative">
        <section id="hero" className="relative overflow-hidden px-6 pt-32 pb-12 sm:pt-36">
          <div className="inset-0 z-0 hidden mask-t-from-70% lg:absolute">
            <WallpaperBackground wallpaperId="brandmark" />
          </div>

          <div className="mx-auto max-w-6xl">
            <section className="w-full">
              <h1 className="text-foreground mt-5 text-4xl leading-[1.1] font-medium tracking-tight md:text-5xl">
                {tHome('heroCommandCenter')}
                <br />
                <span className="text-muted-foreground">{tHome('heroAiWorkforce')}</span>
              </h1>
              <p className="text-muted-foreground mt-6 max-w-xl text-lg leading-relaxed">
                {tHome('heroDescription')}
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Button size="xl" variant="secondary" asChild>
                  <Link href={DEMO_URL}>
                    {tHardcodedUi.raw('appHomePage.line149JsxTextTalkToSales')}
                  </Link>
                </Button>
                <Button size="xl" onClick={handleLaunch}>
                  {tHome('startBuildingCta')}
                  <HiArrowRight className="size-4" />
                </Button>
              </div>
            </section>

            <div id="demo" className="relative z-10 mt-14 scroll-mt-24 sm:mt-20">
              <InteractiveDemo />
            </div>
          </div>
        </section>

        <section
          id="work-loop"
          className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24"
        >
          <Reveal>
            <div className="mb-8 max-w-2xl">
              <Eyebrow>{tHome('workLoopEyebrow')}</Eyebrow>
              <h2 className="text-foreground mt-3 text-2xl leading-tight font-medium tracking-tight sm:text-3xl md:text-4xl">
                {tHome('workLoopTitle')}
              </h2>
              <p className="text-muted-foreground mt-4 text-base leading-relaxed">
                {tHome('workLoopDescription')}
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="border-border bg-card overflow-hidden rounded-sm border">
              <div className="border-border/60 flex flex-wrap gap-2 border-b p-3">
                {WORK_LOOPS.map((loop) => {
                  const isActive = activeLoop.id === loop.id;
                  return (
                    <button
                      key={loop.id}
                      type="button"
                      onClick={() => setActiveLoopId(loop.id)}
                      className={cn(
                        'relative rounded px-3 py-2 text-left text-sm font-medium transition-colors',
                        isActive
                          ? 'text-background'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      )}
                    >
                      {isActive && (
                        <motion.span
                          layoutId="workLoopActiveTab"
                          aria-hidden
                          className="bg-foreground pointer-events-none absolute inset-0 z-0 rounded"
                          transition={
                            reduceMotion
                              ? { duration: 0 }
                              : { type: 'spring', stiffness: 380, damping: 32 }
                          }
                        />
                      )}
                      <span className="relative z-10">{tHome(loop.titleKey)}</span>
                    </button>
                  );
                })}
              </div>
              <div className="grid gap-0 lg:grid-cols-[0.9fr_1.4fr]">
                <div className="border-border/60 border-b p-6 lg:border-r lg:border-b-0">
                  <div className="text-muted-foreground flex items-center gap-2 font-mono text-xs tracking-wider uppercase">
                    <HiMiniSparkles className="size-3.5" />
                    {activeLoop.agent}
                  </div>
                  <p className="text-foreground mt-4 text-xl leading-snug font-medium">
                    "{tHome(activeLoop.promptKey)}"
                  </p>
                </div>
                <div className="grid sm:grid-cols-2">
                  {activeLoop.steps.map(([labelKey, detailKey], index) => (
                    <div
                      key={detailKey}
                      className={cn(
                        'border-border/60 group p-6',
                        index < 2 && 'border-b',
                        index % 2 === 0 && 'sm:border-r',
                      )}
                    >
                      <div
                        className="animate-kortix-bullet-flow bg-size-[100%_300%] bg-clip-text font-mono text-xs font-semibold tracking-wider text-transparent uppercase"
                        style={{
                          backgroundImage: KORTIX_BULLET_GRADIENT,
                          animationDelay: `${index * 0.3}s`,
                        }}
                      >
                        {tHome(labelKey)}
                      </div>
                      <p className="text-muted-foreground group-hover:text-foreground mt-3 text-sm leading-relaxed font-medium transition-colors duration-200">
                        {tHome(detailKey)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </Reveal>
        </section>

        <section id="scroll-card" className="py-16 sm:py-24">
          <div className="mx-auto flex max-w-6xl flex-col gap-10 px-6 sm:gap-12">
            <Reveal>
              <div className="mb-12 max-w-2xl">
                <Eyebrow>{tHome('differentScreenEyebrow')}</Eyebrow>
                <h2 className="mt-3 text-3xl font-medium text-balance md:text-4xl lg:tracking-tight">
                  {tHome('differentScreenSectionTitle')}
                </h2>
                <p className="text-muted-foreground mt-4 text-base text-balance">
                  {tHome('differentScreenSectionDescription')}
                </p>
              </div>
            </Reveal>
          </div>

          <div ref={screenCardsRef} className="m-auto hidden w-full lg:block">
            <div className="flex w-full items-center justify-center px-6">
              <div className="relative mx-auto grid w-full grid-cols-16 place-items-center items-center gap-4 overflow-visible">
                <motion.div
                  style={{ x: mobileCardX }}
                  className="border-muted-foreground dark:border-card relative z-3 col-span-3 flex aspect-auto h-full shrink-0 items-center justify-center overflow-hidden rounded-xl border-4 shadow-sm"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="https://ke4pydspzeg0nm0o.public.blob.vercel-storage.com/ai-workspace-mobile"
                    alt="Mobile"
                    className="h-full w-full object-cover"
                  />

                  <div className="bg-muted-foreground absolute bottom-3.5 h-1 w-[30%] rounded-full" />
                </motion.div>

                <motion.div
                  style={{ x: middleCardX }}
                  transition={{ duration: 0.5 }}
                  className="border-primary dark:border-card bg-primary dark:bg-card relative z-2 col-span-6 flex aspect-video h-full w-full min-w-0 flex-1 flex-row items-center justify-center gap-1 rounded-[calc(var(--radius)+2px)] border-4 p-0.5 pl-0 shadow-sm"
                >
                  <div className="flex h-full min-h-0 w-12 flex-col items-center justify-start gap-5 py-2">
                    <FaUsers className="text-background/80 dark:text-primary/80 size-[1.2rem]" />
                    <PiChatsCircleFill className="text-background/80 dark:text-primary/80 size-[1.2rem]" />
                    <PiBellFill className="text-background/80 dark:text-primary/80 size-[1.2rem]" />
                    <PiFilesFill className="text-background/80 dark:text-primary/80 size-[1.2rem]" />
                    <FiBookmark className="text-background/80 dark:text-primary/80 size-[1.2rem]" />
                    <HiOutlineDotsHorizontal className="text-background/80 dark:text-primary/80 size-[1.2rem]" />
                  </div>
                  <div
                    ref={chatDemoDesktopRef}
                    className="bg-background flex h-full min-h-0 flex-1 flex-col items-end justify-end space-y-4 rounded-md p-4"
                  >
                    <AnimatePresence initial={false}>
                      {visibleChatMessages >= 1 ? (
                        <motion.div
                          key="chat-message-1"
                          initial={{
                            opacity: 0,
                            y: 10,
                          }}
                          animate={{
                            opacity: 1,
                            y: 0,
                          }}
                          transition={{
                            duration: 0.5,
                            ease: 'easeIn',
                          }}
                          className="flex w-full flex-row items-start justify-start gap-2"
                        >
                          <span className="bg-primary flex size-[2.1rem] shrink-0 items-center justify-center rounded-md">
                            <KortixLogo size={16} className="text-background" />
                          </span>
                          <div className="flex min-w-0 flex-1 flex-col gap-0">
                            <div className="flex flex-row items-center justify-start gap-1">
                              <span
                                className="text-foreground block truncate text-xs font-semibold"
                                style={{
                                  textBox: 'trim-both',
                                }}
                              >
                                Kortix
                              </span>
                              <span
                                className="bg-muted rounded-[0.2rem] p-[0.07rem] px-1 py-[0.04rem] text-[7px]"
                                style={{ textBox: 'trim-both' }}
                              >
                                APP
                              </span>
                              <span className="text-[9px]" style={{ textBox: 'trim-both' }}>
                                {new Date(Date.now()).toLocaleDateString('en-US', {
                                  year: 'numeric',
                                  month: 'long',
                                  day: 'numeric',
                                })}
                              </span>
                            </div>
                            <span
                              className="text-muted-foreground block truncate text-xs font-medium"
                              style={{
                                textBox: 'trim-both',
                              }}
                            >
                              Hey! 👋 What can I help you with?
                            </span>
                          </div>
                        </motion.div>
                      ) : null}

                      {visibleChatMessages >= 2 ? (
                        <motion.div
                          key="chat-message-2"
                          initial={{
                            opacity: 0,
                            y: 10,
                          }}
                          animate={{
                            opacity: 1,
                            y: 0,
                          }}
                          transition={{
                            duration: 0.5,
                            ease: 'easeIn',
                          }}
                          className="flex w-full flex-row items-start justify-start gap-2"
                        >
                          <span className="bg-primary relative flex size-[2.1rem] shrink-0 items-center justify-center overflow-hidden rounded-md">
                            <Image
                              src="https://ke4pydspzeg0nm0o.public.blob.vercel-storage.com/marko.png"
                              alt="Marko Kraemer"
                              className="size-full"
                              fill
                            />
                          </span>

                          <div className="flex min-w-0 flex-1 flex-col gap-0">
                            <div className="flex flex-row items-center justify-start gap-1">
                              <span
                                className="text-foreground block truncate text-xs font-semibold"
                                style={{
                                  textBox: 'trim-both',
                                }}
                              >
                                Marko
                              </span>
                              <span className="text-[9px]" style={{ textBox: 'trim-both' }}>
                                {new Date(Date.now()).toLocaleDateString('en-US', {
                                  year: 'numeric',
                                  month: 'long',
                                  day: 'numeric',
                                })}
                              </span>
                            </div>
                            <span
                              className="text-muted-foreground block truncate text-xs font-medium"
                              style={{
                                textBox: 'trim-both',
                              }}
                            >
                              What happened while I was sleeping?
                            </span>
                          </div>
                        </motion.div>
                      ) : null}

                      {visibleChatMessages >= 3 ? (
                        <motion.div
                          key="chat-message-3"
                          initial={{
                            opacity: 0,
                            y: 10,
                          }}
                          animate={{
                            opacity: 1,
                            y: 0,
                          }}
                          transition={{
                            duration: 0.3,
                            ease: 'easeIn',
                          }}
                          className="flex w-full flex-row items-start justify-start gap-2"
                        >
                          <span className="bg-primary flex size-[2.1rem] shrink-0 items-center justify-center rounded-md">
                            <KortixLogo size={16} className="text-background" />
                          </span>
                          <div className="flex min-w-0 flex-1 flex-col gap-0">
                            <div className="flex flex-row items-center justify-start gap-1">
                              <span
                                className="text-foreground block truncate text-xs font-semibold"
                                style={{
                                  textBox: 'trim-both',
                                }}
                              >
                                Kortix
                              </span>
                              <span
                                className="bg-muted rounded-[0.2rem] p-[0.07rem] px-1 py-[0.04rem] text-[7px]"
                                style={{ textBox: 'trim-both' }}
                              >
                                APP
                              </span>
                              <span className="text-[9px]" style={{ textBox: 'trim-both' }}>
                                {new Date(Date.now()).toLocaleDateString('en-US', {
                                  year: 'numeric',
                                  month: 'long',
                                  day: 'numeric',
                                })}
                              </span>
                            </div>
                            <div
                              className="text-muted-foreground block text-xs font-medium"
                              style={{
                                textBox: 'trim-both',
                              }}
                            >
                              <ChatMorningBriefReply />
                            </div>
                          </div>
                        </motion.div>
                      ) : null}
                    </AnimatePresence>

                    <div className="border-border bg-card w-full shrink-0 rounded-(--radius-lg) border">
                      <div className="px-3 py-2">
                        <Textarea
                          minHeight={20}
                          maxHeight={10}
                          placeholder="Type your message here..."
                          className="resize-none rounded-none border-none bg-transparent p-0 text-xs shadow-none focus-visible:ring-0"
                        />
                      </div>
                      <div className="flex items-center justify-between px-1.5 pb-1.5">
                        <div className="text-muted-foreground flex items-center">
                          <span className="flex size-7 items-center justify-center">
                            <Plus className="size-[1.05rem] stroke-[1.5]" />
                          </span>
                          <span className="flex size-7 items-center justify-center text-[0.8rem] font-semibold tracking-tight">
                            Aa
                          </span>
                          <span className="flex size-7 items-center justify-center">
                            <Smile className="size-[1.05rem] stroke-[1.5]" />
                          </span>
                          <span className="flex size-7 items-center justify-center">
                            <AtSign className="size-[1.05rem] stroke-[1.5]" />
                          </span>
                          <span className="flex size-7 items-center justify-center">
                            <MoreHorizontal className="size-[1.05rem] stroke-[1.5]" />
                          </span>
                        </div>
                        <div className="text-muted-foreground flex items-center">
                          <span className="flex size-7 items-center justify-center">
                            <svg
                              className="size-[1.05rem]"
                              width="24"
                              height="24"
                              fill="currentColor"
                              viewBox="0 0 24 24"
                              xmlns="http://www.w3.org/2000/svg"
                            >
                              <path d="M20.04 2.323c1.016-.355 1.992.621 1.637 1.637l-5.925 16.93c-.385 1.098-1.915 1.16-2.387.097l-2.859-6.432 4.024-4.025a.75.75 0 0 0-1.06-1.06l-4.025 4.024-6.432-2.859c-1.063-.473-1-2.002.097-2.387z" />
                            </svg>
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </motion.div>

                <motion.div
                  style={{ x: desktopCardX }}
                  transition={{ duration: 0.5 }}
                  className="border-primary dark:border-card relative z-1 col-span-7 aspect-video h-full w-full min-w-0 flex-1 rounded-[calc(var(--radius)+2px)] border-5 shadow-sm"
                >
                  <InteractiveDemo
                    gradientbg={false}
                    tab={false}
                    className="max-w-full"
                    contentClassName="max-w-full md:p-0 lg:p-0 p-0 "
                    innerClassName="border-none shadow-none bg-primary dark:bg-card rounded-none"
                    aside={false}
                  />
                </motion.div>
              </div>
            </div>
          </div>

          <div className="scrollbar-hide w-full overflow-x-auto scroll-smooth pb-12 lg:hidden">
            <div className="flex w-full gap-2 pl-6">
              <div className="border-primary dark:border-card relative aspect-9/19.5 h-[min(95vw,480px)] shrink-0 overflow-hidden rounded-xl border-4 shadow-sm">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="https://play-lh.googleusercontent.com/cOVrXDLdhhoyLso-DO_R267tBMzWEayo10WvzWin7FSxYy8P09bLmzbmAVAgv4nTBTA9hxSAq55GxVGzMHcCTA=w5120-h2880"
                  alt="Mobile"
                  className="h-full w-full object-cover"
                />
                <div className="bg-muted-foreground absolute bottom-3.5 left-1/2 h-1 w-[30%] -translate-x-1/2 rounded-full" />
              </div>

              <div className="border-primary dark:border-card bg-primary dark:bg-card relative z-2 flex aspect-video h-[min(95vw,480px)] w-[100%] shrink-0 flex-row items-center justify-center gap-1 overflow-y-auto rounded-[calc(var(--radius)+2px)] border-4 p-0.5 pl-0 shadow-sm">
                <div className="flex h-full min-h-0 w-12 flex-col items-center justify-start gap-5 py-2">
                  <FaUsers className="text-background/80 dark:text-primary/80 size-[1.2rem]" />
                  <PiChatsCircleFill className="text-background/80 dark:text-primary/80 size-[1.2rem]" />
                  <PiBellFill className="text-background/80 dark:text-primary/80 size-[1.2rem]" />
                  <PiFilesFill className="text-background/80 dark:text-primary/80 size-[1.2rem]" />
                  <FiBookmark className="text-background/80 dark:text-primary/80 size-[1.2rem]" />
                  <HiOutlineDotsHorizontal className="text-background/80 dark:text-primary/80 size-[1.2rem]" />
                </div>
                <div
                  ref={chatDemoMobileRef}
                  className="bg-background flex h-full min-h-0 flex-1 flex-col items-end justify-end space-y-4 rounded-md p-4"
                >
                  <AnimatePresence initial={false}>
                    {visibleChatMessages >= 1 ? (
                      <motion.div
                        key="chat-message-1"
                        initial={{
                          opacity: 0,
                          y: 10,
                        }}
                        animate={{
                          opacity: 1,
                          y: 0,
                        }}
                        transition={{
                          duration: 0.5,
                          ease: 'easeIn',
                        }}
                        className="flex w-full flex-row items-start justify-start gap-2"
                      >
                        <span className="bg-primary flex size-[2.1rem] shrink-0 items-center justify-center rounded-md">
                          <KortixLogo size={16} className="text-background" />
                        </span>
                        <div className="flex min-w-0 flex-1 flex-col gap-0">
                          <div className="flex flex-row items-center justify-start gap-1">
                            <span
                              className="text-foreground block truncate text-xs font-semibold"
                              style={{
                                textBox: 'trim-both',
                              }}
                            >
                              Kortix
                            </span>
                            <span
                              className="bg-muted rounded-[0.2rem] p-[0.07rem] px-1 py-[0.04rem] text-[7px]"
                              style={{ textBox: 'trim-both' }}
                            >
                              APP
                            </span>
                            <span className="text-[9px]" style={{ textBox: 'trim-both' }}>
                              {new Date(Date.now()).toLocaleDateString('en-US', {
                                year: 'numeric',
                                month: 'long',
                                day: 'numeric',
                              })}
                            </span>
                          </div>
                          <span
                            className="text-muted-foreground block truncate text-xs font-medium"
                            style={{
                              textBox: 'trim-both',
                            }}
                          >
                            Hey! 👋 What can I help you with?
                          </span>
                        </div>
                      </motion.div>
                    ) : null}

                    {visibleChatMessages >= 2 ? (
                      <motion.div
                        key="chat-message-2"
                        initial={{
                          opacity: 0,
                          y: 10,
                        }}
                        animate={{
                          opacity: 1,
                          y: 0,
                        }}
                        transition={{
                          duration: 0.5,
                          ease: 'easeIn',
                        }}
                        className="flex w-full flex-row items-start justify-start gap-2"
                      >
                        <span className="bg-primary relative flex size-[2.1rem] shrink-0 items-center justify-center overflow-hidden rounded-md">
                          <Image
                            src="https://ke4pydspzeg0nm0o.public.blob.vercel-storage.com/marko.png"
                            alt="Marko Kraemer"
                            className="size-full"
                            fill
                          />
                        </span>

                        <div className="flex min-w-0 flex-1 flex-col gap-0">
                          <div className="flex flex-row items-center justify-start gap-1">
                            <span
                              className="text-foreground block truncate text-xs font-semibold"
                              style={{
                                textBox: 'trim-both',
                              }}
                            >
                              Marko
                            </span>
                            <span className="text-[9px]" style={{ textBox: 'trim-both' }}>
                              {new Date(Date.now()).toLocaleDateString('en-US', {
                                year: 'numeric',
                                month: 'long',
                                day: 'numeric',
                              })}
                            </span>
                          </div>
                          <span
                            className="text-muted-foreground block truncate text-xs font-medium"
                            style={{
                              textBox: 'trim-both',
                            }}
                          >
                            What happened while I was sleeping?
                          </span>
                        </div>
                      </motion.div>
                    ) : null}

                    {visibleChatMessages >= 3 ? (
                      <motion.div
                        key="chat-message-3"
                        initial={{
                          opacity: 0,
                          y: 10,
                        }}
                        animate={{
                          opacity: 1,
                          y: 0,
                        }}
                        transition={{
                          duration: 0.3,
                          ease: 'easeIn',
                        }}
                        className="flex w-full flex-row items-start justify-start gap-2"
                      >
                        <span className="bg-primary flex size-[2.1rem] shrink-0 items-center justify-center rounded-md">
                          <KortixLogo size={16} className="text-background" />
                        </span>
                        <div className="flex min-w-0 flex-1 flex-col gap-0">
                          <div className="flex flex-row items-center justify-start gap-1">
                            <span
                              className="text-foreground block truncate text-xs font-semibold"
                              style={{
                                textBox: 'trim-both',
                              }}
                            >
                              Kortix
                            </span>
                            <span
                              className="bg-muted rounded-[0.2rem] p-[0.07rem] px-1 py-[0.04rem] text-[7px]"
                              style={{ textBox: 'trim-both' }}
                            >
                              APP
                            </span>
                            <span className="text-[9px]" style={{ textBox: 'trim-both' }}>
                              {new Date(Date.now()).toLocaleDateString('en-US', {
                                year: 'numeric',
                                month: 'long',
                                day: 'numeric',
                              })}
                            </span>
                          </div>
                          <div
                            className="text-muted-foreground block text-xs font-medium"
                            style={{
                              textBox: 'trim-both',
                            }}
                          >
                            <ChatMorningBriefReply />
                          </div>
                        </div>
                      </motion.div>
                    ) : null}
                  </AnimatePresence>

                  <div className="border-border bg-card w-full shrink-0 rounded-(--radius-lg) border">
                    <div className="px-3 py-2">
                      <Textarea
                        minHeight={20}
                        maxHeight={10}
                        placeholder="Type your message here..."
                        className="resize-none rounded-none border-none bg-transparent p-0 text-xs shadow-none focus-visible:ring-0"
                      />
                    </div>
                    <div className="flex items-center justify-between px-1.5 pb-1.5">
                      <div className="text-muted-foreground flex items-center">
                        <span className="flex size-7 items-center justify-center">
                          <Plus className="size-[1.05rem] stroke-[1.5]" />
                        </span>
                        <span className="flex size-7 items-center justify-center text-[0.8rem] font-semibold tracking-tight">
                          Aa
                        </span>
                        <span className="flex size-7 items-center justify-center">
                          <Smile className="size-[1.05rem] stroke-[1.5]" />
                        </span>
                        <span className="flex size-7 items-center justify-center">
                          <AtSign className="size-[1.05rem] stroke-[1.5]" />
                        </span>
                        <span className="flex size-7 items-center justify-center">
                          <MoreHorizontal className="size-[1.05rem] stroke-[1.5]" />
                        </span>
                      </div>
                      <div className="text-muted-foreground flex items-center">
                        <span className="flex size-7 items-center justify-center">
                          <svg
                            className="size-[1.05rem]"
                            width="24"
                            height="24"
                            fill="currentColor"
                            viewBox="0 0 24 24"
                            xmlns="http://www.w3.org/2000/svg"
                          >
                            <path d="M20.04 2.323c1.016-.355 1.992.621 1.637 1.637l-5.925 16.93c-.385 1.098-1.915 1.16-2.387.097l-2.859-6.432 4.024-4.025a.75.75 0 0 0-1.06-1.06l-4.025 4.024-6.432-2.859c-1.063-.473-1-2.002.097-2.387z" />
                          </svg>
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="border-primary dark:border-card relative z-1 aspect-video h-[min(95vw,480px)] w-[100%] shrink-0 overflow-hidden rounded-[calc(var(--radius)+2px)] border-5 shadow-sm">
                <InteractiveDemo
                  gradientbg={false}
                  tab={false}
                  className="w-full max-w-full"
                  contentClassName="max-w-full mx-0 md:p-0 lg:p-0 p-0 "
                  innerClassName="border-none shadow-none bg-primary dark:bg-card rounded-none"
                  aside={false}
                />
              </div>
            </div>
          </div>
        </section>

        <section
          id="two-paths"
          className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24"
        >
          <Reveal>
            <div className="mb-12 max-w-2xl">
              <Eyebrow>{tHome('splitEyebrow')}</Eyebrow>
              <h2 className="text-foreground mt-3 text-2xl leading-tight font-medium tracking-tight sm:text-3xl md:text-4xl">
                {tHome('splitTitle')}
              </h2>
              <p className="text-muted-foreground mt-4 text-base leading-relaxed">
                {tHome('splitDescription')}
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {SPLIT_PATHS.map(
                ({ icon: Icon, eyebrowKey, titleKey, bodyKey, points, ctaKey, href, variant }) => (
                  <div
                    key={titleKey}
                    className="border-border bg-card flex h-full flex-col rounded-sm border p-6 sm:p-8"
                  >
                    <div className="text-muted-foreground flex items-center gap-2 font-mono text-xs tracking-wider uppercase">
                      <Icon className="size-4" />
                      {tHome(eyebrowKey)}
                    </div>
                    <h3 className="text-foreground mt-5 text-2xl leading-tight font-medium tracking-tight">
                      {tHome(titleKey)}
                    </h3>
                    <p className="text-muted-foreground mt-4 text-base leading-relaxed">
                      {tHome(bodyKey)}
                    </p>
                    <ul className="mt-6 space-y-3 pb-8">
                      {points.map((pointKey, index) => (
                        <li
                          key={pointKey}
                          className="text-muted-foreground flex items-start gap-3 text-sm leading-relaxed"
                        >
                          <KortixAsterisk index={index} />
                          {tHome(pointKey)}
                        </li>
                      ))}
                    </ul>
                    <Button asChild size="lg" className="mt-auto" variant={variant}>
                      <Link href={href}>
                        {tHome(ctaKey)}
                        <HiArrowRight className="size-4" />
                      </Link>
                    </Button>
                  </div>
                ),
              )}
            </div>
          </Reveal>
        </section>

        <section
          id="code-window"
          className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24"
        >
          <Reveal>
            <div className="mb-12 max-w-2xl">
              <Eyebrow>{tHome('companyAsCodeEyebrow')}</Eyebrow>
              <h2 className="mt-3 text-3xl font-medium text-balance md:text-4xl lg:tracking-tight">
                {tHome('companyAsCodeTitle')}
              </h2>
              <p className="text-muted-foreground mt-4 text-base text-balance">
                {tHome('companyAsCodeDescription')}
              </p>
            </div>
          </Reveal>

          <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-2 lg:gap-14">
            <Reveal>
              <CodeWindow />
            </Reveal>
            <Reveal delay={0.1}>
              <div className="w-full">
                <ul className="space-y-3.5">
                  {[
                    'companyAsCodeBulletConfig',
                    'companyAsCodeBulletAgents',
                    'companyAsCodeBulletGit',
                    'companyAsCodeBulletSelfHost',
                  ].map((key, index) => (
                    <li
                      key={key}
                      className="text-muted-foreground flex items-start gap-3 text-sm leading-relaxed"
                    >
                      <KortixAsterisk index={index} />
                      {tHome(key)}
                    </li>
                  ))}
                </ul>
                <ItemGroup className="border-border mx-auto mt-8 overflow-hidden rounded border text-left">
                  <Item
                    asChild
                    variant="muted"
                    size="sm"
                    className="group relative flex-nowrap rounded-none border-0"
                  >
                    <Link href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
                      <ItemMedia variant="icon" className="rounded">
                        <Icon.Github />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>
                          <span className="tabular-nums">{formattedStars}</span>{' '}
                          {tHardcodedUi.raw('appHomePage.line267JsxTextStarsOnGitHub')}
                        </ItemTitle>
                        <ItemDescription>
                          {tHardcodedUi.raw(
                            'appHomePage.line269JsxTextALeadingOpenSourceAIWorkspace',
                          )}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions className="mt-auto">
                        <span className="text-muted-foreground duration-slower absolute top-2 right-2 block shrink-0 origin-top-right translate-x-2 -translate-y-2 rotate-180 opacity-0 transition-all ease-in group-hover:translate-x-0 group-hover:translate-y-0 group-hover:-scale-100 group-hover:opacity-100 md:hidden [&>svg]:size-5">
                          <TbChevronUpRight />
                        </span>
                        <span className="text-muted-foreground font-mono text-sm max-md:hidden">
                          kortix-ai/kortix
                        </span>
                      </ItemActions>
                    </Link>
                  </Item>
                </ItemGroup>
              </div>
            </Reveal>
          </div>
        </section>

        <section
          id="workspace-map"
          className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24"
        >
          <Reveal>
            <div className="mb-12 max-w-2xl">
              <Eyebrow>{tHome('workforceMapEyebrow')}</Eyebrow>
              <h2 className="mt-3 text-3xl font-medium text-balance md:text-4xl lg:tracking-tight">
                {tHome('workforceMapTitle')}
              </h2>
              <p className="text-muted-foreground mt-4 text-base text-balance">
                {tHome('workforceMapDescription')}
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <section className="flex flex-col items-center gap-5 pb-24 md:gap-0">
              <div className="relative grid w-full grid-cols-2 gap-5 md:grid-cols-4">
                {WORKFORCE_MAP_CAPABILITIES.map(({ icon: Icon, titleKey, descKey }) => (
                  <div
                    key={titleKey}
                    className="group border-border bg-card hover:bg-background flex w-full flex-col justify-between gap-4 rounded-sm border p-4 shadow-sm transition md:aspect-[283/200]"
                  >
                    <div className="bg-secondary group-hover:bg-card self-start rounded-lg p-2.5">
                      <Icon className="text-foreground size-5 shrink-0" />
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <p className="text-foreground text-base transition">{tHome(titleKey)}</p>
                      <p className="text-muted-foreground text-sm text-balance transition">
                        {tHome(descKey)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>

              <svg
                viewBox="0 0 956 54"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                className="text-border mx-auto hidden max-w-[956px] md:block"
              >
                <defs>
                  <linearGradient id="flow" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--kortix-blue)" />
                    <stop offset="100%" stopColor="var(--background)" />
                  </linearGradient>

                  <linearGradient id="reveal" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="white" stopOpacity="0" />
                    <stop offset="45%" stopColor="white" stopOpacity="1" />
                    <stop offset="55%" stopColor="white" stopOpacity="1" />
                    <stop offset="100%" stopColor="white" stopOpacity="0" />
                    <animateTransform
                      attributeName="gradientTransform"
                      type="translate"
                      from="0 -1"
                      to="0 1"
                      dur="2.5s"
                      repeatCount="indefinite"
                    />
                  </linearGradient>

                  <mask id="mask">
                    <rect width="956" height="54" fill="url(#reveal)" />
                  </mask>
                </defs>

                {PATHS.map((d, i) => (
                  <path
                    key={`b${i}`}
                    d={d}
                    stroke="currentColor"
                    strokeOpacity="0.5"
                    strokeWidth="2"
                  />
                ))}

                <g mask="url(#mask)">
                  {PATHS.map((d, i) => (
                    <path key={`g${i}`} d={d} stroke="url(#flow)" strokeWidth="2" />
                  ))}
                </g>
              </svg>

              <div className="text-body-sm relative mx-auto grid w-full max-w-[856px] grid-flow-col-dense grid-cols-3 grid-rows-2 items-center gap-2 md:mx-auto md:flex md:w-auto md:flex-row md:gap-5">
                {WORKFORCE_MAP_DOMAINS.slice(0, 2).map(({ icon: Icon, labelKey }) => (
                  <div
                    key={labelKey}
                    className="group bg-card text-foreground border-border flex h-[46px] items-center justify-center gap-0.5 rounded-sm border px-6 py-3 transition md:gap-2"
                  >
                    <Icon className="size-4 shrink-0" />
                    <p>{tHome(labelKey)}</p>
                  </div>
                ))}

                <div className="group text-foreground bg-foreground row-span-2 flex h-full w-full flex-col items-center justify-center gap-0.5 rounded-sm px-6 py-3 transition hover:brightness-90 md:h-[64px] md:w-[105px] md:gap-2">
                  <KortixLogo className="text-background" />
                </div>

                {WORKFORCE_MAP_DOMAINS.slice(2, 4).map(({ icon: Icon, labelKey }) => (
                  <div
                    key={labelKey}
                    className="group bg-card text-foreground border-border flex h-[46px] items-center justify-center gap-0.5 rounded-sm border px-6 py-3 transition md:gap-2"
                  >
                    <Icon className="size-4 shrink-0" />
                    <p>{tHome(labelKey)}</p>
                  </div>
                ))}

                <div className="bg-border absolute top-1/2 left-0 z-[-1] hidden h-[2px] w-full md:block"></div>
              </div>
            </section>
          </Reveal>
        </section>

        <section
          id="integrations"
          className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24"
        >
          <Reveal>
            <div className="mb-14 max-w-2xl">
              <Eyebrow>{tHome('integrationsEyebrow')}</Eyebrow>
              <h2 className="text-muted-foreground mt-3 text-2xl leading-tight font-medium tracking-tight sm:text-3xl md:text-4xl">
                {tHome('integrationsTitlePrefix')}{' '}
                <span className="text-foreground font-medium">
                  {tHome('integrationsTitle')}
                </span>{' '}
              </h2>
              <p className="text-muted-foreground mt-4 text-base leading-relaxed">
                {tHome('integrationsDescription')}
              </p>
            </div>
          </Reveal>
          <LogoMarqueeRows />
        </section>

        <section
          id="enterprise"
          className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24"
        >
          <Reveal>
            <div className="mb-12 max-w-2xl">
              <Eyebrow>{tHome('enterpriseEyebrow')}</Eyebrow>
              <h2 className="mt-3 text-3xl font-medium text-balance md:text-4xl lg:tracking-tight">
                {tHome('enterpriseTitle')}
              </h2>
              <p className="text-muted-foreground mt-4 text-base text-balance">
                {tHome('enterpriseDescription')}
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="grid grid-cols-1 gap-10 sm:grid-cols-2 md:gap-16 lg:grid-cols-4">
              {[
                {
                  icon: FaUsers,
                  titleKey: 'enterpriseScopedTitle',
                  descriptionKey: 'enterpriseScopedDescription',
                },
                {
                  icon: MdShield,
                  titleKey: 'enterpriseApprovalsTitle',
                  descriptionKey: 'enterpriseApprovalsDescription',
                },
                {
                  icon: Box,
                  titleKey: 'enterpriseIsolationTitle',
                  descriptionKey: 'enterpriseIsolationDescription',
                },
                {
                  icon: Server,
                  titleKey: 'enterpriseDeployTitle',
                  descriptionKey: 'enterpriseDeployDescription',
                },
              ].map(({ icon: Icon, titleKey, descriptionKey }) => (
                <div key={titleKey} className="flex flex-col space-y-6">
                  <span className="shrink-0">
                    <Icon className="size-5" />
                  </span>
                  <span className="text-foreground text-lg">
                    <span className="font-semibold">{tHome(titleKey)}.</span>{' '}
                    <span className="text-muted-foreground leading-relaxed font-medium">
                      {tHome(descriptionKey)}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </Reveal>
        </section>

        <section
          id="use-cases"
          className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24"
        >
          <Reveal>
            <div className="mb-2 max-w-2xl">
              <Eyebrow>{tHome('useCasesEyebrow')}</Eyebrow>
              <h2 className="mt-3 text-3xl font-medium text-balance md:text-4xl lg:tracking-tight">
                {tHome('useCasesTitle')}
              </h2>
              <p className="text-muted-foreground mt-4 text-base text-balance">
                {tHome('useCasesDescription')}
              </p>
            </div>
          </Reveal>

          <Reveal>
            <div className="border-border bg-card grid w-full grid-cols-1 overflow-hidden rounded border lg:grid-cols-12">
              <div
                role="tablist"
                aria-orientation="vertical"
                className="scrollbar-hide border-border/60 col-span-12 flex gap-2 overflow-x-auto border-b p-3 lg:col-span-4 lg:flex-col lg:gap-0 lg:overflow-visible lg:border-r lg:border-b-0 lg:p-0"
              >
                {USE_CASE_DEMOS.map((demo) => {
                  const copy = useCaseCopy[demo.id];
                  const isActive = demo.id === activeUseCase.id;
                  const Icon = demo.icon;
                  return (
                    <button
                      key={demo.id}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      aria-controls={`use-case-panel-${demo.id}`}
                      id={`use-case-tab-${demo.id}`}
                      onClick={() => setActiveUseCaseId(demo.id)}
                      className={cn(
                        'group relative flex shrink-0 rounded-sm p-4 text-left transition-colors lg:rounded-none lg:border-b lg:p-5 lg:last:border-b-0',
                        isActive ? '' : 'hover:bg-muted/30',
                      )}
                    >
                      {isActive && (
                        <motion.span
                          layoutId="useCaseActiveTab"
                          aria-hidden
                          className="dark:bg-muted/60 bg-popover pointer-events-none absolute inset-0 z-0 rounded-sm lg:rounded-none"
                          // style={{ boxShadow: 'inset 2px 0 0 0 var(--primary)' }}
                          transition={
                            reduceMotion
                              ? { duration: 0 }
                              : { type: 'spring', stiffness: 380, damping: 32 }
                          }
                        />
                      )}
                      <span className="relative z-10 flex w-full flex-col gap-1">
                        <span className="flex items-center gap-2.5">
                          <Icon
                            className={cn(
                              'size-4 shrink-0 transition-colors',
                              isActive ? 'text-primary' : 'text-muted-foreground',
                            )}
                          />
                          <span
                            className={cn(
                              'font-mono text-xs tracking-wider whitespace-nowrap uppercase transition-colors',
                              isActive ? 'text-foreground' : 'text-muted-foreground',
                            )}
                          >
                            {copy.tabTitle}
                          </span>
                        </span>
                        <span className="text-muted-foreground hidden pl-[1.625rem] text-sm leading-snug lg:block">
                          {copy.tabDescription}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>

              <div
                role="tabpanel"
                id={`use-case-panel-${activeUseCase.id}`}
                aria-labelledby={`use-case-tab-${activeUseCase.id}`}
                className="relative col-span-12 h-full min-h-[22rem] lg:col-span-8"
              >
                <div className="flex h-full flex-1 grow flex-col p-6 sm:p-8">
                  <h3 className="text-foreground text-2xl leading-tight font-medium tracking-tight sm:text-3xl">
                    {activeUseCaseCopy.title}
                  </h3>
                  <p className="text-muted-foreground mt-4 text-base leading-relaxed">
                    {activeUseCaseCopy.description}
                  </p>
                  <div className="border-border/60 bg-background/40 mt-6 overflow-hidden rounded-sm border">
                    <div className="border-border/60 flex items-center gap-2 border-b px-4 py-2.5">
                      <span aria-hidden className="bg-primary mt-0.5 h-2 w-1 shrink-0" />
                      <span className="text-muted-foreground font-mono text-xs tracking-wider">
                        kortix run
                      </span>
                    </div>
                    <motion.ul
                      key={activeUseCase.id}
                      initial={reduceMotion ? false : 'hidden'}
                      animate={reduceMotion ? false : 'show'}
                      variants={{
                        hidden: {},
                        show: { transition: { staggerChildren: 0.07, delayChildren: 0.05 } },
                      }}
                      className="space-y-2 p-4 font-mono text-xs sm:text-sm"
                    >
                      {activeUseCaseCopy.log.map((line, i) => (
                        <motion.li
                          key={i}
                          variants={{ hidden: { opacity: 0, x: -4 }, show: { opacity: 1, x: 0 } }}
                          transition={{ duration: 0.25, ease: 'easeOut' }}
                          className="text-muted-foreground flex gap-2 leading-relaxed"
                        >
                          <KortixAsterisk index={i} parentClass="mt-0" />
                          <span>
                            {line}
                            {i === activeUseCaseCopy.log.length - 1 && !reduceMotion && (
                              <motion.span
                                aria-hidden
                                className="bg-primary ml-1 inline-block h-3.5 w-1.5 translate-y-[2px] align-middle"
                                animate={{ opacity: [1, 0] }}
                                transition={{
                                  duration: 0.8,
                                  repeat: Infinity,
                                  repeatType: 'reverse',
                                }}
                              />
                            )}
                          </span>
                        </motion.li>
                      ))}
                    </motion.ul>
                  </div>
                  <Button asChild variant="ghost" className="text-primary mt-auto self-start">
                    <Link href={`/use-cases/${activeUseCase.slug}`}>
                      {tHome('useCasesLearnMore')}
                      <HiArrowRight className="size-4" />
                    </Link>
                  </Button>
                </div>
              </div>
            </div>
          </Reveal>
        </section>

        <section id="cta" className="relative mx-auto max-w-6xl px-6 py-16 sm:py-24">
          <Reveal>
            <div className="border-border bg-card relative overflow-hidden rounded-sm border text-center">
              <div className="flex grid-cols-12 flex-col-reverse gap-2 md:grid">
                <div className="col-span-4 flex flex-col items-start justify-start space-y-4 p-6 *:text-left">
                  <div className="space-y-2">
                    <Badge variant="update" className="rounded">
                      Start building
                    </Badge>
                    <h2 className="text-foreground text-2xl leading-tight font-medium tracking-tight sm:text-3xl">
                      {tHardcodedUi.raw('appHomePage.line331JsxTextGiveYourCompanyAWorkforce')}
                    </h2>

                    <ul className="mt-6 space-y-3 pb-8">
                      {(
                        tHardcodedUi.raw(
                          'appHomePage.line334JsxTextFreeToSelfHostManagedCloudFrom20',
                        ) as string[]
                      ).map((line, index) => (
                        <li
                          key={line}
                          className="text-muted-foreground flex items-start gap-3 text-sm leading-relaxed"
                        >
                          <KortixAsterisk index={index} />
                          {line}
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="mt-auto grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
                    <Button size="lg" className="w-full" onClick={handleLaunch}>
                      {tHardcodedUi.raw('appHomePage.line337JsxTextGetStarted')}
                      <HiArrowRight className="size-4" />
                    </Button>
                    <Button asChild size="lg" className="w-full" variant="accent">
                      <Link href={DEMO_URL}>
                        {tHardcodedUi.raw('appHomePage.line338JsxTextTalkToSales')}
                      </Link>
                    </Button>
                  </div>
                </div>
                <div className="col-span-8 mask-y-from-90% mask-x-from-90%">
                  <KortixGrid count={58} seed={4228} />
                </div>
              </div>
            </div>
          </Reveal>
        </section>

        <div className="h-24 sm:h-28" />
      </div>
    </>
  );
}
