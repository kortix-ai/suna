---
name: website-building-webapp
description: "Use for app-like web experiences built from the website-building template and references."
---

# Fullstack Web App

Build fullstack web applications using an opinionated pre-wired template: Express + Vite + React + Tailwind CSS + shadcn/ui + Drizzle ORM.

## Getting Started

Copy the template to your project directory, then install dependencies:

```bash
cp -r skills/GENERAL-KNOWLEDGE-WORKER/webapp/template/ <project-name>/
cd <project-name>
npm install
```

Run the dev server:

```bash
npm run dev
```

This starts an Express server for the backend and a Vite server for the frontend on the same port.

## Build Order

Follow this order strictly:

1. **Schema** — Define your data model in `shared/schema.ts` first
2. **Frontend** — Build all React components and pages
3. **Backend** — Implement Express routes in `server/routes.ts`
4. **Integration** — Wire frontend to backend via queryClient

## Architecture

- Put as much of the app in the frontend as possible. The backend should only be responsible for data persistence and making API calls.
- Minimize the number of files. Collapse similar components into a single file.
- If the app is complex and requires functionality that can't be done in a single request, it is okay to stub out the backend and implement the frontend first.
- CRITICAL: NEVER use `localStorage`, `sessionStorage`, `indexedDB`, or cookies — they are blocked in the sandboxed iframe and will crash the page. Use React state or context for transient data, and the backend API + in-memory storage for persistent data.

---

## Webapp Template — Design Notes

The shared design files (see **References** below) are the authoritative source for all design decisions — colors, fonts, type scale, spacing. This section only covers **template-specific workflow** that the shared files don't address.

### Replacing `red` Placeholders in `index.css`

The template's `index.css` ships with `red` placeholder values that must be replaced before the app looks right. **Infer a palette from the subject matter first** — a fitness tracker should feel energetic (bright accent, dark surfaces), a recipe app should feel warm (amber/terracotta tones), a finance dashboard should feel precise (cool neutrals, blue accent). Derive colors from the product's domain, not from a generic default.

When deriving a custom palette, use HSL values in `H S% L%` format (no `hsl()` wrapper) and maintain both `:root` and `.dark` variants following the same variable structure in `index.css`.

If the subject gives no clear color signal AND the user provided no direction after being asked, fall back to the Kortix HSL values from `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/01-design-tokens.md` → "Kortix HSL Equivalents" section.

### Webapp-Specific Type and Font Rules

- **`text-xl` is the max heading size.** Web apps (SaaS, dashboards, admin, e-commerce) never use `text-2xl` or above. Exception: brand experience marketing/landing hero sections — see Art Direction table below.
- **Font variable mapping:** The shared files define `--font-display` and `--font-body`. In this Tailwind template, both map to `font-sans` — use bold/semibold weight for display territory, regular weight for body territory.

---

## Art Direction by Product Type

| Product Type | Concept-Driven Direction | Token Starting Points |
|---|---|---|
| **SaaS / productivity** | A writing tool is calm and typographic. A project management tool is structured and efficient. A design tool is visual and spacious. Match personality to purpose. | Neutral surfaces. 1 accent. Body font that matches the product's character. |
| **Dashboard / analytics** | Finance dashboards demand precision and sobriety. Marketing dashboards can be warmer and more visual. The data's domain sets the tone. | Sans-serif + monospace for data. High-contrast. Load `skills/GENERAL-KNOWLEDGE-WORKER/webapp/dashboards.md`. |
| **E-commerce** | Luxury goods: muted surfaces, serif display, restrained accent. Kids' toys: warm, bright, rounded. Outdoor gear: earthy tones, rugged sans-serif. | Warm palette derived from product category. Strong CTA contrast. |
| **Brand experience** | A music streaming brand differs from an architecture studio. Derive everything from the brand. | Display font at `--text-xl` in-app; `--text-2xl` ONLY for marketing/landing hero sections. 1-2 custom accent hues. Theatrical motion. |
| **Admin panel** | Utilitarian, clear, efficient. A healthcare admin panel feels different from a developer tools panel. | Inter or DM Sans (loaded via CDN, not system fonts). Functional color only. Dense layout. |

---

## Best Practices by App Type

### SaaS Products & Dashboards

- **Sidebar navigation** with collapsible sections and pinnable items
- **Dark mode as first-class** — many dashboard users work in low-light environments
- **Real-time updates** — WebSockets or SSE for live data. "Last updated: 2m ago" for non-live data
- **Export everything** — CSV, PDF, image for every chart and table
- **Role-based views** — admin vs member vs viewer with different permissions
- **Onboarding checklist** — persistent progress tracker for new users

### E-Commerce & Online Stores

- **Product pages:** Hero image (zoomable, multi-angle), price, "Add to Cart" above the fold, shipping info, reviews
- **Fast checkout.** Guest checkout always. Auto-fill. 3 steps max: Cart > Shipping > Payment
- **Faceted search** with real-time results. Filter by price, category, rating, availability
- **Cart persistence.** Survives page refresh and session
- **Trust signals.** Secure checkout badge, return policy, shipping estimates, reviews, payment logos
- **Mobile shopping.** Sticky "Add to Cart", swipeable images, Apple Pay / Google Pay

### Brand Experiences & Marketing Apps

- **Scroll-driven narrative.** GSAP ScrollTrigger for pinned sections, scrubbing, parallax
- **Full-screen immersive sections.** Hero moments with video, animation, or interactive 3D
- **Micro-interactions that reward exploration.** Hover effects, parallax, cursor-following
- **Performance despite richness.** Lazy-load heavy content. Intersection Observer. Compress media
- **Responsive storytelling.** Pinned horizontal scroll on desktop becomes vertical stack on mobile

---

## Types

- Always think through and generate the data model first in `shared/schema.ts` to ensure consistency between frontend and backend. Do this before writing any other code.
- Keep the data model as simple as possible (e.g. don't add createdAt and updatedAt fields unless it is strictly necessary).
- For each model, additionally write:
  - The insert schema using `createInsertSchema` from `drizzle-zod`. Use `.omit` to exclude any auto-generated fields.
  - The insert type using `z.infer<typeof insertSchema>`
  - The select type using `typeof table.$inferSelect`.
- Common pitfalls to avoid:
  - When writing array columns in the Drizzle schema, always call `.array()` as a method on the column type, not as a wrapper function. That is, do `text().array()` instead of `array(text())`.

## Storage

- Make sure to update `IStorage` in `server/storage.ts` to accommodate any storage CRUD operations you need in the application.
- Ensure that storage interface uses the types from `@shared/schema.ts`.

## Backend

- Write API routes inside `registerRoutes(httpServer, app)` in `server/routes.ts`. The `app` parameter is the Express instance — use `app.get()`, `app.post()`, etc. to define routes.
- Always use the storage interface to do any CRUD operations. Keep the routes as thin as possible.
- Validate the request body using Zod schemas from `drizzle-zod` before passing it to the storage interface.
- Do NOT create a separate server file — the template's `server/index.ts` already sets up Express and calls `registerRoutes`.

## Frontend

- CRITICAL: You MUST use `useHashLocation` from `wouter/use-hash-location` in your Router and App.tsx. When writing or rewriting App.tsx, always include `import { useHashLocation } from "wouter/use-hash-location"` and pass `hook={useHashLocation}` to the Router component. Without this, all routing will break after deployment because sites are served inside iframes where path-based routing breaks.
  - Routes use hash paths: `/#/`, `/#/tasks`, `/#/boats/:id`
  - Use `<Link href="/tasks">` — wouter handles the hash prefix automatically when `useHashLocation` is the router hook.
  - If you need to add a new page, add them to the `client/src/pages` directory and register them in `client/src/App.tsx`.
  - If there are multiple pages, use a sidebar for navigation. Use the `Link` component or the `useLocation` hook from `wouter` instead of modifying the window directly.
  - NEVER use `href="#section"` anchor links for in-page navigation — hash routing intercepts these as route changes, causing a "not found" error. Instead, use `onClick` handlers with `document.getElementById('section')?.scrollIntoView({ behavior: 'smooth' })` to scroll to sections within the same page.
- For forms, always use shadcn's `useForm` hook and `Form` component from `@/components/ui/form` which wraps `react-hook-form`.
  - When appropriate, use the `zodResolver` from `@hookform/resolvers/zod` to validate the form data using the appropriate insert schema from `@shared/schema.ts`.
  - Use `.extend` to add validation rules to the insert schema.
  - Remember that the form component is controlled, ensure you pass default values to the `useForm` hook.
- Always use `@tanstack/react-query` when fetching data.
  - When appropriate, ensure you strongly type the query using the appropriate select type from `@shared/schema.ts`.
  - Prefer the default queryFn (which routes through `API_BASE` for deployment). If you must write a custom queryFn (e.g., for response parsing or query params), use `apiRequest` from `@/lib/queryClient` — NEVER use raw `fetch()`. Raw `fetch()` bypasses `__PORT_5000__` URL rewriting and API calls will 404 after deployment.
  - Use `apiRequest` from `@/lib/queryClient` for ALL HTTP requests to the backend (GET, POST, PATCH, DELETE) — both in queries and mutations.
    - Always make sure to invalidate the cache by queryKey after a mutation is made. Don't forget to import `queryClient` from `@lib/queryClient`!
    - For hierarchical or variable query keys use an array for cache segments so cache invalidation works properly. That is, do queryKey: ['/api/recipes', id] instead of queryKey: [`/api/recipes/${id}`].
  - Show a loading or skeleton state while queries (via `.isLoading`) or mutations (via `.isPending`) are being made
  - The template uses TanStack Query v5 which only allows the object form for query related functions. e.g. `useQuery({ queryKey: ['key'] })` instead of `useQuery(['key'])`
- Common pitfalls to avoid:
  - The `useToast` hook is exported from `@/hooks/use-toast`.
  - If a form is failing to submit, try logging out `form.formState.errors` to see if there are form validation errors for fields that might not have associated form fields.
  - DO NOT explicitly import React as the existing Vite setup has a JSX transformer that does it automatically.
  - Use `import.meta.env.<ENV_VAR>` to access environment variables on the frontend instead of `process.env.<ENV_VAR>`. Note that variables must be prefixed with `VITE_` in order for the env vars to be available on the frontend.
  - <SelectItem> will throw an error if it has no value prop. Provide a value prop like this <SelectItem value="option1">
- Add a `data-testid` attribute to every HTML element that users can interact with (buttons, inputs, links, etc.) and to elements displaying meaningful information (user data, status messages, dynamic content, key values).
  - Use unique, descriptive identifiers following this pattern:
    - Interactive elements: `{action}-{target}` (e.g., `button-submit`, `input-email`, `link-profile`)
    - Display elements: `{type}-{content}` (e.g., `text-username`, `img-avatar`, `status-payment`)
  - For dynamically generated elements (lists, grids, repeated components), append a unique identifier at the end: `{type}-{description}-{id}`
    - Examples: `card-product-${productId}`, `row-user-${index}`, `text-price-${itemId}`
    - The dynamic identifier can be any unique value (database ID, index, key) as long as it's unique within that group
  - Keep test IDs stable and descriptive of the element's purpose rather than its appearance or implementation details.

## Styling and Theming

- Uses Tailwind CSS v3. Use `@tailwind base; @tailwind components; @tailwind utilities;` directives in CSS. Do NOT use `@import "tailwindcss"` or `@theme` syntax — those are v4 and will crash the dev server.
- When defining custom properties in `index.css` that will be used by a tailwind config, always use H S% L% (space separated with percentages after Saturation and Lightness) (and do not wrap in hsl()).
  - For example:
     --my-var: 23 10% 23%;
- Analyze the comments inside of `index.css` to determine how to set colors — replacing every `red` placeholder. **Infer a palette from the product's subject matter first** (see "Replacing `red` Placeholders" above). Use Kortix HSL values from `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/01-design-tokens.md` only as a last-resort fallback when both inference and asking the user yield no direction. Do NOT forget to replace every single instance of `red`. Pay attention to what you see in index.css.
- Use the `@`-prefixed paths to import shadcn components and hooks.
- Use icons from `lucide-react` to signify actions and provide visual cues. Use `react-icons/si` for company logos.
- User may attach assets (images, etc.) in their request.
  - If the user asks you to include attached assets in the app, you can reference them in the frontend with the `@assets/...` import syntax.
  - For example, if the user attached asset is at `attached_assets/example.png`, you can reference it in the frontend with `import examplePngPath from "@assets/example.png"`.

## Dark Mode

1. Set `darkMode: ["class"]` in tailwind.config.ts and define color variables in :root and .dark CSS classes
2. Create ThemeProvider with `useState` seeded from `window.matchMedia("(prefers-color-scheme: dark)")`, and a `useEffect` to toggle the `"dark"` class on `document.documentElement`. Do not use localStorage or cookies for theme persistence — they are blocked in the sandboxed iframe.
3. When not using utility class names configured in `tailwind.config.ts`, always use explicit light/dark variants for ALL visual properties: `className="bg-white dark:bg-black text-black dark:text-white"`. When using utility classes configured in tailwind config, you can assume these already been configured to automatically adapt to dark mode.

## Running the Project

Run `npm run dev` to start the development server. This starts Express for the backend and Vite for the frontend on the same port. After making edits, the server will automatically reload.

## Installing Packages

If you need to install additional packages, run `npm install <package-name>`.

## Testing

Read `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/12-playwright-interactive.md` for testing and QA. Use the `agent-browser` skill to navigate, interact with, and screenshot your local dev server.

## Deployment

**Static-only apps (no server logic):**

Build the frontend and deploy the static output:

```bash
cd <project-name>
npm run build
```

Then deploy with `a real deploy command(project_path="<project-name>/dist/public")`.

**Apps with backend (most webapp projects):**

The template runs Express on port 5000. After building, deploy the static output and the backend server handles API calls via port proxy:

1. Build: `npm run build`
2. Start the production server: `pty_spawn(command="NODE_ENV=production node dist/index.cjs", project_path="<project>", port=5000)`
3. Deploy: `a real deploy command(project_path="<project>/dist/public", site_name="...", entry_point="index.html")`

The template's `queryClient.ts` uses `__PORT_5000__` which `a real deploy command` replaces with the proxy path at deploy time. API calls work both locally (relative `/api/...`) and deployed (proxied through `port/5000/api/...`). Read `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/19-backend.md` for details.

## Config File Guidance

- Do NOT modify the Vite setup (`server/vite.ts` and `vite.config.ts`) unless absolutely necessary. It is already configured to serve the frontend and backend on the same port and handles all the necessary setup for you. Don't add a proxy to the Vite server. All the aliases are already set up for you to import.
- Do NOT modify `drizzle.config.ts` unless absolutely necessary. It is pre-configured correctly.

## Environment

Read `skills/GENERAL-KNOWLEDGE-WORKER/webapp/references/environment.md` — pre-installed packages, dev server setup, deployment constraints.

## References

**Before writing code**, read the shared design files below (mandatory). Then identify whether any webapp-specific reference applies to the task. If it does, read it in parallel with `skills/GENERAL-KNOWLEDGE-WORKER/webapp/references/environment.md`.

**Shared design guidance (authoritative — read first):**

These files come from the `website-building` dependency and live under `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/` — NOT under `skills/GENERAL-KNOWLEDGE-WORKER/webapp/shared/`.

- `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/01-design-tokens.md` — **Always read.** Type scale, spacing system, Kortix palette, base stylesheet. Provides the fallback design system when the user gives no art direction.
- `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/02-typography.md` — **Always read.** Font selection (Fontshare preferred), display vs. body rules, font blacklist, variable font features.
- `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/03-motion.md` — **Read when the app has animation.** Easing blueprint (which curve for which context), duration quick-reference, spring presets, scroll-driven CLS rules, AnimatePresence patterns. The webapp elevation system for hover/active states is noted inside — the rest of the guidance (easing curves, timing, page transitions, stagger patterns) applies fully.
- `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/05-taste.md` — **Read for any user-facing app.** Design taste principles: simplicity, fluidity, feedback, restraint. Defines the "feel" quality bar — progressive disclosure, context-preserving overlays, micro-interactions.
- `skills/GENERAL-KNOWLEDGE-WORKER/website-building/shared/08-standards.md` — **Always read.** Accessibility (WCAG AA, semantic HTML, keyboard nav), performance baselines, and AI aesthetic anti-patterns to avoid.

**Webapp-specific references:**

These files live under `skills/GENERAL-KNOWLEDGE-WORKER/webapp/references/`.

- `references/shadcn_component_rules.md` - Use when building or modifying UI with Shadcn components (especially Button, Card, Badge, Avatar, and Textarea).
- `references/layout_and_spacing.md` - Use when structuring page layouts, sections, spacing rhythm, and component alignment.
- `references/sidebar_rules.md` - Use when building or modifying a sidebar.
- `references/visual_style_and_contrast.md` - Use when choosing contrast, borders, shadows, pane/panel treatment, and hero image presentation.

## SEO

- Ensure every page has a unique, descriptive title tag (e.g., "Product Name - Category | Site Name")
- Add meta descriptions that summarize page content concisely
- Implement Open Graph tags for better social media sharing appearance