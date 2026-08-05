'use client';

/**
 * `Icon` is a re-export barrel kept ONLY so existing `Icon.Foo` call sites
 * keep compiling. Each member lives in its own module under `./icons/` so it
 * can be imported directly and tree-shaken — prefer
 * `import { Foo } from '@/features/icon/icons/foo'` in new code instead of
 * importing this whole object.
 */
import { ApparelMagic } from './icons/apparel-magic';
import { Apple } from './icons/apple';
import { AppleCursor } from './icons/apple-cursor';
import { BorderRadius } from './icons/border-radius';
import { Brain } from './icons/brain';
import { BrainHigh } from './icons/brain-high';
import { BrainLow } from './icons/brain-low';
import { BrainMedium } from './icons/brain-medium';
import { Calendar } from './icons/calendar';
import { ChatGPT } from './icons/chat-gpt';
import { Claude } from './icons/claude';
import { Close } from './icons/close';
import { Codex } from './icons/codex';
import { Copy } from './icons/copy';
import { Cursor } from './icons/cursor';
import { Discord } from './icons/discord';
import { Facebook } from './icons/facebook';
import { FullN8N } from './icons/full-n8n';
import { Gemini } from './icons/gemini';
import { Github } from './icons/github';
import { Gmail } from './icons/gmail';
import { Google } from './icons/google';
import { GooglePlayStore } from './icons/google-play-store';
import { Gradient } from './icons/gradient';
import { HamBurger } from './icons/ham-burger';
import { Instagram } from './icons/instagram';
import { Kortix } from './icons/kortix';
import { Linear } from './icons/linear';
import { LinkedIn } from './icons/linked-in';
import { Linux } from './icons/linux';
import { MagnifyingGlass } from './icons/magnifying-glass';
import { MarginBottom } from './icons/margin-bottom';
import { MarginLeft } from './icons/margin-left';
import { MarginRight } from './icons/margin-right';
import { MarginTop } from './icons/margin-top';
import { MarginX } from './icons/margin-x';
import { MarginY } from './icons/margin-y';
import { MicrosoftTeams } from './icons/microsoft-teams';
import { Minus } from './icons/minus';
import { Monitor } from './icons/monitor';
import { Moon } from './icons/moon';
import { N8N } from './icons/n8n';
import { NewGoogle } from './icons/new-google';
import { NextJS } from './icons/next-js';
import { Notion } from './icons/notion';
import { NPM } from './icons/npm';
import { OpenAI } from './icons/open-ai';
import { OpenClaw } from './icons/open-claw';
import { HarnessMark as OpenCode } from './icons/open-code';
import { Outlook } from './icons/outlook';
import { PaddingBottom } from './icons/padding-bottom';
import { PaddingLeft } from './icons/padding-left';
import { PaddingRight } from './icons/padding-right';
import { PaddingTop } from './icons/padding-top';
import { PaddingX } from './icons/padding-x';
import { PaddingY } from './icons/padding-y';
import { Personalisation } from './icons/personalisation';
import { Plus } from './icons/plus';
import { Reddit } from './icons/reddit';
import { Shield } from './icons/shield';
import { Shopify } from './icons/shopify';
import { SidebarClosed } from './icons/sidebar-closed';
import { SidebarOpen } from './icons/sidebar-open';
import { Slack } from './icons/slack';
import { Sparkles } from './icons/sparkles';
import { Stripe } from './icons/stripe';
import { StripeBrand } from './icons/stripe-brand';
import { Sun } from './icons/sun';
import { Supabase } from './icons/supabase';
import { Telegram } from './icons/telegram';
import { Twitter } from './icons/twitter';
import { Vercel } from './icons/vercel';
import { Verified } from './icons/verified';
import { Viktor } from './icons/viktor';
import { WhatsApp } from './icons/whats-app';
import { Windows } from './icons/windows';
import { YtShorts } from './icons/yt-shorts';
import { Zapier } from './icons/zapier';

export const Icon = {
  Kortix,
  NewGoogle,
  Google,
  Gemini,
  Claude,
  OpenAI,
  Cursor,
  Codex,
  OpenCode,
  Gmail,
  Github,
  Instagram,
  YtShorts,
  Supabase,
  MarginX,
  MarginY,
  MarginTop,
  MarginBottom,
  MarginLeft,
  MarginRight,
  PaddingX,
  PaddingY,
  PaddingTop,
  PaddingBottom,
  PaddingLeft,
  PaddingRight,
  BorderRadius,
  Plus,
  Minus,
  NextJS,
  NPM,
  Brain,
  Sparkles,
  MagnifyingGlass,
  Slack,
  MicrosoftTeams,
  StripeBrand,
  Stripe,
  Copy,
  Shield,
  Calendar,
  LinkedIn,
  Twitter,
  BrainLow,
  BrainMedium,
  BrainHigh,
  Gradient,
  AppleCursor,
  Close,
  Facebook,
  HamBurger,
  Personalisation,
  N8N,
  FullN8N,
  Discord,
  Notion,
  Shopify,
  Linear,
  Outlook,
  SidebarOpen,
  SidebarClosed,
  Telegram,
  Reddit,
  Vercel,
  ApparelMagic,
  Sun,
  Moon,
  Monitor,
  ChatGPT,
  Zapier,
  OpenClaw,
  Viktor,
  WhatsApp,
  Verified,
  Apple,
  GooglePlayStore,
  Windows,
  Linux,
};
