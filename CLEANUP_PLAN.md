# Cleanup Plan for contexts, hooks, and lib folders

## 🗑️ CONTEXTS FOLDER CLEANUP

### ✅ Keep (Used):
- **SubscriptionContext.tsx** - Used in 4 places
  - BUT: Remove unused hooks `useHasCredits` and `useSubscriptionTier` (never imported)

### ❌ Consider Removing:
- **BillingContext.tsx** - Only used in ThreadComponent, but there's already a local `useBilling` hook doing the same thing
  - **Action**: Migrate to using the local hook directly, remove context

### ✅ Keep:
- **DeleteOperationContext.tsx** - Used in 3 places (sidebar, dashboard, status overlay)

---

## 🗑️ HOOKS FOLDER CLEANUP

### 🔴 BILLING HOOKS DUPLICATION (HIGH PRIORITY):

1. **`use-billing-v2.ts`** ✅ KEEP - New API, used by:
   - SubscriptionContext
   - activate-trial page
   - credit-balance-card

2. **`subscriptions/use-billing.ts`** ❌ CHECK IF USED - Old API hook
   - Only exported in index.ts, need to verify if anything imports it

3. **`threads/use-billing-status.ts`** ✅ KEEP - Thread-specific, used by:
   - BillingContext
   - useBilling hook

### ✅ Keep (React Query hooks organized well):
- All hooks in `react-query/` subfolders are well organized
- Main hooks folder has utility hooks that are used

### 🔍 Check for unused hooks:
- `use-announcement-store.ts` - Check if used
- `use-agent-version-data.ts` - Check if used  
- `use-cached-file.ts` - Check if used
- `use-file-content.ts` - Check if used (might be duplicate with react-query version)

---

## 🗑️ LIB FOLDER CLEANUP

### ⚠️ MISPLACED FILE:
- **`lib/home.tsx`** - Contains `siteConfig` and `PricingTier` 
  - Used in 20+ places
  - **Action**: Consider moving to `lib/site.ts` or `lib/config.ts` (already has site.ts with siteConfig!)

### ✅ Keep (Core utilities):
- `api.ts` - Main API functions
- `api-client.ts` - API client setup
- `api-server.ts` - Server-side API
- `config.ts` - Configuration
- `error-handler.ts` - Error handling
- `validation.ts` - Validation utilities
- `utils.ts` - General utilities
- All subfolders (api/, supabase/, utils/, stores/, versioning/)

### 🔍 Check:
- `cache-init.ts` - Check if used
- `mermaid-utils.ts` - Check if used
- `model-provider-icons.tsx` - Check if used
- `polyfills.ts` - Check if used
- `edge-flags.ts` - Check if used

---

## 📋 RECOMMENDED ACTIONS:

### Priority 1 (Duplicates/Dead Code):
1. ✅ Remove `useHasCredits` and `useSubscriptionTier` from SubscriptionContext (unused)
2. ✅ Check if `subscriptions/use-billing.ts` is used, delete if not
3. ✅ Consider removing `BillingContext.tsx` and migrate to local hook
4. ✅ Consolidate `lib/home.tsx` into `lib/site.ts`

### Priority 2 (Organization):
5. Check for duplicate file hooks vs react-query hooks
6. Verify all hooks in main hooks folder are used
7. Check lib utilities for unused exports

### Priority 3 (Polish):
8. Ensure consistent naming (some hooks use `use-`, some don't)
9. Consider grouping related hooks better

