'use client';

import { CopyButton } from '@/components/markdown/copy-button';

import { localizeUiCatalog, translateUiCatalogText } from '@/i18n/localize-ui-catalog';
import { PRODUCT_CATALOG_TRANSLATION_KEYS } from '@/i18n/product-catalog-translation-keys.generated';
import type { UiTranslator } from '@/i18n/translator';

import { cn } from '@/lib/utils';
import { type App, type AppAccessMode, type AppCapability, type AppDeployment, type AppInstance, type AppInstanceOperation, type AppViewerTokenScope } from '@kortix/sdk';


type DeploymentTone = 'success' | 'destructive' | 'warning' | 'muted';

/**
 * Every deployment status, in words a person who did not build this can read.
 *
 * The raw values are pipeline stages — `validating`, `provisioning`, `checking`
 * — and they were rendered verbatim into a badge. That is the vocabulary of the
 * thing that runs the build, not of the person watching it, and `provisioning`
 * in particular tells a reader nothing they can act on.
 *
 * One table instead of the if-chain this replaces: the chain listed five of the
 * eight statuses by hand to reach one tone, so adding a status to the union got
 * `muted` and silence rather than a type error. A `Record` over the union does
 * not compile until every new status is given a label and a tone.
 */
export const DEPLOYMENT_COPY: Record<
  AppDeployment['status'],
  { label: string; tone: DeploymentTone }
> = {
  queued: { label: 'Waiting', tone: 'warning' },
  validating: { label: 'Checking files', tone: 'warning' },
  building: { label: 'Building', tone: 'warning' },
  provisioning: { label: 'Starting up', tone: 'warning' },
  checking: { label: 'Final checks', tone: 'warning' },
  ready: { label: 'Live', tone: 'success' },
  failed: { label: 'Failed', tone: 'destructive' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
};

/**
 * What the HEADER says about the newest deployment — or nothing at all.
 *
 * Deliberately coarser than the table above. A header badge is read at a glance
 * while you are using the App, and at that moment the difference between
 * `validating` and `provisioning` is not a difference the reader can do
 * anything with: both mean "a new version is on its way". The version list is
 * where the stage-by-stage detail belongs, and it has it.
 *
 * `null` is the common case, and it is the point. A finished deployment is what
 * every App looks like almost all of the time, so saying "Live" there would put
 * a permanent badge in the header restating the green dot beside it. Cancelled
 * is silent for the same reason: nothing is happening and nothing is broken.
 */
export function deployNotice(
  latest: AppDeployment | undefined,
  tI18nComplete: UiTranslator,
): { label: string; tone: DeploymentTone } | null {
  if (!latest || latest.status === 'ready' || latest.status === 'cancelled') return null;
  if (latest.status === 'failed')
    return { label: tI18nComplete.raw('texte58282fd73fb'), tone: 'destructive' };
  return { label: tI18nComplete.raw('text0b5260e1b405'), tone: 'warning' };
}

export function appCommand(app: App): string {
  return `kortix apps deploy . --app ${app.app_id}`;
}


/**
 * The hostname a person reads an App by.
 *
 * `app.url` is a full origin (`https://seed.apps.kortix.com`). The scheme is
 * the same on every App and the trailing slash is noise, so both are dropped —
 * a card's second line is 300px wide and every character it spends on `https://`
 * is a character the actual subdomain loses to truncation.
 *
 * Exported for its own test: this is pure string work with a live input shape,
 * which is exactly what `apps/web` can assert without a DOM.
 */
export function appHost(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

/**
 * Everything the UI says about an App's state, derived in ONE place.
 *
 * `desired_state` defaults to `'running'` the moment an App row is created, so
 * it is intent, not fact — an App that has never been deployed reports
 * `running` and has no runtime at all. Every surface must therefore read
 * `active_deployment_id` first, and it does so here rather than in each of the
 * three places that used to re-derive it. A static App is live whenever it
 * has an active deployment (`hosting_type`).
 */
export function appStatus(
  app: App,
  tI18nComplete: UiTranslator,
): { deployed: boolean; live: boolean; label: string; dot: string } {
  if (app.instance) return instanceStatus(app.instance, tI18nComplete);
  const deployed = Boolean(app.active_deployment_id);
  // A static App has no runtime: it serves whatever `desired_state` says.
  const live = deployed && (app.desired_state === 'running' || app.hosting_type === 'static');
  return {
    deployed,
    live,
    label: translateUiCatalogText(
      !deployed ? 'Not deployed' : live ? 'Running' : 'Suspended',
      tI18nComplete,
      PRODUCT_CATALOG_TRANSLATION_KEYS,
    ),
    // Three states, three weights of the same neutral-vs-green pair: running is
    // the only one that earns colour.
    dot: live ? 'bg-kortix-green' : deployed ? 'bg-muted-foreground/50' : 'bg-muted-foreground/25',
  };
}

/**
 * The state of an App that runs its own machine (`app.instance`, kind
 * `convex`). Its deployments never move `active_deployment_id`, so the
 * machine, not the deployment pointer, says whether it is up. An operation in
 * flight (resize, snapshot, restore, key rotation, recovery) wins over the
 * machine state; a failed health probe reads as not responding.
 */
function instanceStatus(
  instance: AppInstance,
  t: UiTranslator,
): { deployed: boolean; live: boolean; label: string; dot: string } {
  const running = instance.status === 'running';
  const live = running && !instance.operation && instance.health?.ok !== false;
  const label = instance.operation
    ? instanceOperationLabel(instance.operation, t)
    : instance.status === 'provisioning'
      ? t.raw('textc2b1b8e2e039')
      : running
        ? instance.health?.ok === false
          ? t.raw('textd14f65e63358')
          : t.raw('textf4ccae29e1bb')
        : instance.status === 'error'
          ? t.raw('text54a0e8c17ebb')
          : t.raw('textb48ff39c2e0f');
  return {
    deployed: running,
    live,
    label,
    dot: live ? 'bg-kortix-green' : running ? 'bg-muted-foreground/50' : 'bg-muted-foreground/25',
  };
}

/** What an App's machine is doing right now, as a status label. */
function instanceOperationLabel(operation: AppInstanceOperation, t: UiTranslator): string {
  const labels: Record<AppInstanceOperation, string> = {
    resizing: t.raw('text6f2769b24c0f'),
    rotating_key: t.raw('text4a75e77ccc8d'),
    recovering: t.raw('text959bdc881c93'),
    snapshotting: t.raw('textcd08dcee6a87'),
    restoring: t.raw('text5a4918e0201c'),
  };
  return labels[operation];
}

/**
 * Does this App offer `capability`? The ONE way the Apps UI branches between
 * kinds: the server lists what each App supports (`app.capabilities`), and a
 * control shows only for the Apps that support it.
 */
export function appCan(app: App, capability: AppCapability): boolean {
  return app.capabilities?.includes(capability) ?? false;
}

/** The kind badge on a card and in the detail header. `null` for kind `web`, the default every App reads as. */
export function appKindLabel(app: App, t: UiTranslator): string | null {
  return app.kind === 'convex' ? t.raw('text2fb4019a35e4') : null;
}

/** "2 vCPU · 4 GB · 20 GB": the machine size of an App. */
export function appSizeLabel(app: App, t: UiTranslator): string {
  return t('textce0eabb01151', {
    value0: app.machine.cpu,
    value1: app.machine.memory_gb,
    value2: app.machine.disk_gb,
  });
}

/** Only an on-demand server App has a monthly budget; every other App costs a fixed amount. */
export function appHasBudget(app: App): boolean {
  return (
    (app.kind ?? 'web') === 'web' &&
    app.always_on === false &&
    app.hosting_type !== 'static' &&
    typeof app.monthly_budget_usd === 'number'
  );
}

/** "About $59 a month": the fixed cost of an always-on server App or a Convex App. `null` when none applies. */
export function appCostLabel(app: App, t: UiTranslator): string | null {
  if (app.hosting_type === 'static' || appHasBudget(app) || !app.estimated_monthly_usd) return null;
  return t('texte15cb9ffae7f', { value0: Math.round(app.estimated_monthly_usd) });
}

/**
 * Who can open an App, in the words the picker shows.
 *
 * Module scope, above every consumer. It used to be declared BELOW
 * `AppDetailModal`, the component that reads it — legal, because the read
 * happens at render rather than at module evaluation, and confusing for exactly
 * as long as it takes to check whether it is.
 */
export const ACCESS_COPY: Record<AppAccessMode, { label: string; desc: string }> = {
  // "Only you" stated a guarantee the code does not make: a project manager can
  // always open and operate an App (appVisibleToSubject), deliberately, so a
  // private App does not become unmanageable the moment its creator leaves the
  // account. A false promise about access, in the one dialog where people
  // reason about access, is worse than a longer label.
  private: { label: 'Just you', desc: 'You, and anyone who can manage this project' },
  project: { label: 'Whole team', desc: 'Every member of this project' },
  restricted: { label: 'Select members', desc: 'Chosen members and groups' },
  // These two describe PUBLIC traffic only. Both are still team-visible: a
  // password protects the App's hostname from the internet, it never hides the
  // App from the teammates who operate it. Read as "only people with the
  // password", it hides that every project member can open it too.
  public: { label: 'Public', desc: 'Anyone with the URL, plus your team' },
  password: { label: 'Password', desc: 'Anyone with the password, plus your team' },
};

/**
 * What a Kortix-hosted App learns about the person looking at it.
 *
 * Ordered the same way `ACCESS_COPY` is — least shared first — so the two
 * pickers in the same modal read as one ladder rather than two dialects. The
 * default is `identity`, which sits in the middle on purpose: an App that
 * greets you by name needs no login of its own, and one that acts as you on the
 * Kortix API is a deliberate step further.
 */
export const VIEWER_SCOPE_COPY: Record<AppViewerTokenScope, { label: string; desc: string }> = {
  off: { label: 'Shares nothing', desc: 'The App never learns who opened it' },
  identity: {
    label: 'Knows who is signed in',
    desc: "The App sees the viewer's Kortix id, email and groups",
  },
  api: {
    label: 'Acts as them in Kortix',
    desc: 'Also calls the Kortix API, limited by their own role',
  },
};

/**
 * Access modes that have no signed-in Kortix viewer to describe.
 *
 * A public App is opened by strangers and a password App by whoever holds the
 * password — neither carries a Kortix identity, so there is nothing to share
 * and the field is left untouched on save.
 */
export const ANONYMOUS_MODES: readonly AppAccessMode[] = ['public', 'password'];

/**
 * A shell command, shown as the thing you would actually type.
 *
 * Radius is concentric: `rounded-md` (6px) outer, `py-1` (4px) padding, so the
 * copy button inside takes `rounded-sm` (2px) — which is what `CopyButton`'s
 * `size="sm"` already carries.
 */
export function DeployCommand({ code, className }: { code: string; className?: string }) {
  return (
    <span
      className={cn(
        'bg-popover inline-flex max-w-full items-center gap-2 rounded-md border py-1 pr-1 pl-2.5',
        className,
      )}
    >
      <span aria-hidden className="text-muted-foreground shrink-0 font-mono text-xs select-none">
        $
      </span>
      <code className="text-foreground truncate font-mono text-xs">{code}</code>
      <CopyButton code={code} size="sm" className="shrink-0" />
    </span>
  );
}


export function localizedAppCopy(tI18nComplete: UiTranslator) {
  return localizeUiCatalog(
    { deployment: DEPLOYMENT_COPY, access: ACCESS_COPY, viewerScope: VIEWER_SCOPE_COPY },
    tI18nComplete,
    PRODUCT_CATALOG_TRANSLATION_KEYS,
  );
}
