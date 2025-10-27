# Library Organization

This directory contains all core API clients, hooks, and utilities organized by domain.

## Structure

```
lib/
├── agents/          # Agent management
│   ├── api.ts       # Type exports
│   ├── hooks.ts     # React Query hooks
│   └── index.ts     # Barrel exports
│
├── billing/         # Billing & subscriptions
│   ├── api.ts       # API client & types
│   ├── hooks.ts     # React Query hooks
│   ├── checkout.ts  # Checkout browser flows
│   ├── pricing.ts   # Pricing tiers & config
│   ├── validation.ts # Billing checks
│   └── index.ts     # Barrel exports
│
├── chat/            # Threads, messages, agent runs
│   ├── api.ts       # Type exports
│   ├── hooks.ts     # React Query hooks
│   └── index.ts     # Barrel exports
│
├── files/           # File & sandbox operations
│   ├── api.ts       # Type exports
│   ├── hooks.ts     # React Query hooks
│   └── index.ts     # Barrel exports
│
├── models/          # Available models
│   ├── api.ts       # Type exports
│   ├── hooks.ts     # React Query hooks
│   └── index.ts     # Barrel exports
│
├── triggers/        # Trigger management
│   ├── api.ts       # Type exports
│   ├── hooks.ts     # React Query hooks
│   └── index.ts     # Barrel exports
│
├── utils/           # General utilities
│   ├── auth-types.ts       # Auth type definitions
│   ├── date.ts             # Date formatting
│   ├── fonts.ts            # Font configurations
│   ├── i18n.ts             # Internationalization
│   ├── icon-mapping.ts     # Icon name mappings
│   ├── markdown-styles.ts  # Markdown rendering styles
│   ├── message-grouping.ts # Message parsing & grouping
│   ├── search.ts           # Search utilities
│   ├── theme.ts            # Theme configuration
│   ├── thread-utils.ts     # Thread helpers
│   ├── tool-parser.ts      # Tool call parsing
│   ├── trigger-utils.ts    # Trigger helpers
│   ├── utils.ts            # General utilities
│   └── index.ts            # Barrel exports
│
└── index.ts         # Main barrel file (exports all modules)
```

## Module Pattern

Each API module (agents, billing, chat, files, models, triggers) follows this pattern:

### `api.ts`
- Type definitions (re-exported from `@/api/types`)
- API client functions (if needed)
- Request/response type interfaces

### `hooks.ts`
- React Query hooks (`useQuery`, `useMutation`)
- Query key factories
- Hook options and configurations
- Uses API functions from `api.ts`

### `index.ts`
- Barrel file that re-exports everything
- Provides convenient named exports
- Entry point for the module

## Usage

### Import from specific modules:
```typescript
// Billing
import { useSubscription, useCreditBalance } from '@/lib/billing';

// Chat
import { useMessages, useSendMessage } from '@/lib/chat';

// Agents
import { useAgents, useAgent } from '@/lib/agents';

// Utils
import { formatConversationDate } from '@/lib/utils';
```

### Import from main barrel (if needed):
```typescript
import { useSubscription, useMessages, useAgents } from '@/lib';
```

## High-Level Hooks

Complex orchestration hooks that combine multiple lib modules remain in `hooks/`:

- `hooks/useChat.ts` - Complete chat orchestration (uses `lib/chat`)
- `hooks/useAuth.ts` - Auth state management
- `hooks/useOnboarding.ts` - Onboarding flow
- `hooks/useNavigation.ts` - Navigation utilities
- `hooks/useAuthDrawer.ts` - Legacy auth redirect

## Guidelines

1. **API modules** (`lib/{domain}/`) contain low-level API interactions
2. **High-level hooks** (`hooks/`) orchestrate multiple API modules
3. **Utils** (`lib/utils/`) contain pure functions and helpers
4. **Each module is self-contained** with its own types and exports
5. **Use barrel files** for clean imports across the app

## Migration

Old structure:
```
hooks/api/useApiQueries.ts  → lib/chat/hooks.ts
hooks/api/useBilling.ts      → lib/billing/{api,hooks}.ts
hooks/api/useAgents.ts       → lib/agents/hooks.ts
lib/stripe.ts                → lib/billing/checkout.ts
lib/utils.ts                 → lib/utils/utils.ts
```

All imports have been updated to use the new structure.

