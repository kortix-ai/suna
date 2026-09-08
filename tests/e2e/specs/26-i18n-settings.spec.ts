import { readFileSync } from "node:fs";

import { expect, test, type Page, type Response } from "@playwright/test";

import { resolvePersonalAccountId } from "../helpers/accounts";
import { queryDatabaseRows, runDatabaseSql } from "../helpers/database";
import { clearCookiesPreservingBypass } from "../helpers/deployment-bypass";
import { createApiJsonClient, createApiResultClient } from "../helpers/http";
import {
  createManifestProject,
  isDeployedTarget,
  type ManifestProject,
} from "../helpers/manifest-project";
import {
  createAuthUser,
  deleteAuthUser,
  installBrowserSessionDirect,
  signIn,
} from "../helpers/session-auth";

const supportedLocales = [
  "de",
  "it",
  "zh",
  "ja",
  "pt",
  "fr",
  "es",
  "sr",
  "en",
] as const;
type Locale = (typeof supportedLocales)[number];
const requestedLocale = process.env.E2E_I18N_LOCALE;
if (requestedLocale && !supportedLocales.includes(requestedLocale as Locale)) {
  throw new Error(`Unsupported E2E_I18N_LOCALE: ${requestedLocale}`);
}
const locales: readonly Locale[] = requestedLocale
  ? [requestedLocale as Locale]
  : supportedLocales;

const nativeLocaleNames: Record<Locale, string> = {
  en: "English",
  de: "Deutsch",
  it: "Italiano",
  zh: "中文",
  ja: "日本語",
  pt: "Português",
  fr: "Français",
  es: "Español",
  sr: "Српски",
};

const publicSurfaceRoutes = [
  "/",
  "/about",
  "/agent-computer",
  "/agents-and-skills",
  "/automations",
  "/blog",
  "/careers",
  "/channels",
  "/changelog",
  "/company-as-code",
  "/connectors",
  "/contact",
  "/design-system",
  "/developers",
  "/download",
  "/enterprise",
  "/legal",
  "/marketplace",
  "/pricing",
  "/security",
  "/self-hosted",
  "/solutions",
  "/support",
  "/use-cases",
] as const;

function productSurfaceRoutes(projectId: string, accountId: string): string[] {
  return [
    "/new",
    "/connections",
    "/accounts",
    `/accounts/${accountId}`,
    `/projects/${projectId}`,
    `/projects/${projectId}/customize/agents`,
    `/projects/${projectId}/customize/skills`,
    `/projects/${projectId}/customize/connectors`,
    `/projects/${projectId}/customize/triggers`,
    `/projects/${projectId}/customize/review`,
    `/projects/${projectId}/customize/models`,
    `/projects/${projectId}/customize/secrets`,
    `/projects/${projectId}/customize/settings`,
    `/projects/${projectId}/channels`,
    `/projects/${projectId}/members`,
    `/projects/${projectId}/apps`,
    `/projects/${projectId}/files`,
    `/projects/${projectId}/sessions`,
  ];
}

interface LocaleMessages {
  common: { close: string };
  projectOnboarding: {
    progress: string;
    company: {
      title: string;
      description: string;
      domain: string;
      continue: string;
    };
    tools: { title: string; searchPlaceholder: string; continue: string };
    slack: { title: string; notNow: string };
    plan: { title: string; continue: string };
    done: { title: string; firstMessage: string; openProject: string };
  };
  billing: {
    plan: {
      currentPlan: string;
      active: string;
    };
  };
  settings: {
    rail: {
      settings: string;
      projectTitle: string;
      backToApp: string;
      groups: Record<string, string>;
      items: Record<string, { label: string; description?: string }>;
    };
    preferences: {
      title: string;
      languageTitle: string;
      keyboardTitle: string;
      modifierKey: string;
      shortcuts: Record<string, string>;
    };
    profile: {
      profilePicture: string;
      email: string;
      name: string;
      organizations: { title: string; manage: string };
      dangerZone: string;
      deleteAccount: string;
    };
    security: {
      twoFactorTitle: string;
      authenticatorApp: string;
      addAuthenticatorApp: string;
      noFactorEnrolled: string;
      devices: string;
      signOutOtherDevices: string;
    };
    appearance: {
      theme: string;
      conversationDensity: string;
      wallpaper: string;
      defaultWallpaper: string;
      themes: Record<string, string>;
      densities: Record<string, { label: string }>;
      wallpapers: Record<string, string>;
    };
    sessions: {
      notifications: string;
      enableNotifications: string;
      notificationTypes: string;
      behavior: string;
      sendTestNotification: string;
      types: Record<string, { label: string; description: string }>;
      notificationBehavior: Record<
        string,
        { label: string; description: string }
      >;
      sounds: string;
      soundPacks: Record<string, { label: string; description: string }>;
      volume: string;
      soundEvents: Record<string, { label: string; description: string }>;
    };
    connected: {
      github: string;
      install: string;
      connect: string;
    };
    tokens: {
      newKey: string;
      emptyTitle: string;
      emptyCanCreate: string;
      serviceAccountTokens: string;
      createTitle: string;
      createDescription: string;
      name: string;
      namePlaceholder: string;
      nameHint: string;
      scope: string;
      wholeWorkspace: string;
      scopeHint: string;
      expires: string;
      expiryNever: string;
      cancel: string;
      createKey: string;
    };
    credits: {
      availableBalance: string;
      buckets: Record<string, { label: string; hint: string }>;
      includedInPlan: string;
      usedThisPeriod: string;
      history: string;
      historyDescription: string;
      openLedger: string;
    };
    workspace: {
      icon: string;
      name: string;
      dangerZone: string;
      deleteWorkspace: string;
    };
    git: { title: string; retry: string };
    sandbox: {
      routing: { title: string; automatic: string };
      provider: { label: string };
      descriptionStart: string;
      actions: { new: string };
      facts: { processor: string; memory: string; storage: string };
      defaultBadge: string;
    };
    snapshots: {
      environment: { notBuilt: { title: string } };
      view: { logTitle: string; empty: string };
      faq: { title: string };
    };
    featureFlags: {
      search: string;
      flags: { marketplace: { name: string; description: string } };
      stability: { beta: string };
    };
    upgrades: {
      available: string;
      upToDate: string;
      oneOff: string;
      runUpgrade: string;
    };
  };
}

interface AccountRow {
  account_id: string;
}

function messages(locale: Locale): LocaleMessages {
  return JSON.parse(
    readFileSync(
      new URL(`../../../apps/web/translations/${locale}.json`, import.meta.url),
      "utf8",
    ),
  ) as LocaleMessages;
}

function stripMessageTags(value: string): string {
  let output = "";
  let insideTag = false;
  for (const character of value) {
    if (character === "<") {
      insideTag = true;
    } else if (character === ">" && insideTag) {
      insideTag = false;
    } else if (!insideTag) {
      output += character;
    }
  }
  return output;
}

function flattenStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string") {
    const normalized = stripMessageTags(value).trim();
    if (
      normalized.length >= 5 &&
      !/[{}]/.test(normalized) &&
      !normalized.includes("://")
    ) {
      output.push(normalized);
    }
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenStrings(item, output);
    return output;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) flattenStrings(item, output);
  }
  return output;
}

const englishMessages = messages("en");
const englishValues = new Set(flattenStrings(englishMessages));
const localizedWitnesses = Object.fromEntries(
  locales.map((locale) => [
    locale,
    locale === "en"
      ? [...englishValues]
      : flattenStrings(messages(locale)).filter(
          (value) => !englishValues.has(value),
        ),
  ]),
) as Record<Locale, string[]>;

async function assertLocalizedRoute(
  page: Page,
  route: string,
  locale: Locale,
  navigationResponse?: Response | null,
): Promise<void> {
  let response = navigationResponse;
  if (!response) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await page.goto(route, { waitUntil: "commit" });
        break;
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "TimeoutError" || attempt === 1) {
          throw error;
        }
      }
    }
  }
  expect(
    response,
    `${locale} ${route} did not return a document`,
  ).not.toBeNull();
  expect(
    response!.status(),
    `${locale} ${route} returned ${response!.status()}`,
  ).toBeLessThan(400);
  await page.waitForLoadState("domcontentloaded", { timeout: 180_000 });
  await expect(page.locator("html"), `${locale} ${route}`).toHaveAttribute(
    "lang",
    locale,
  );
  expect(
    new URL(page.url()).pathname,
    `${locale} ${route} redirected to auth`,
  ).not.toBe("/auth");

  const content = page.locator("main").first();
  const localizedContent =
    (await content.count()) > 0 ? content : page.locator("body");
  await expect(
    localizedContent,
    `${locale} ${route} has no visible content`,
  ).not.toBeEmpty();
  await expect(
    localizedContent,
    `${locale} ${route} contains corrupt Unicode`,
  ).not.toContainText("�");
  await expect
    .poll(
      async () => {
        const text = await localizedContent.innerText();
        return localizedWitnesses[locale].some((candidate) =>
          text.includes(candidate),
        );
      },
      {
        message: `${locale} ${route} did not render any catalog text for that locale`,
        timeout: 30_000,
      },
    )
    .toBe(true);
}

async function chooseLocale(page: Page, locale: Locale): Promise<void> {
  // The locale write goes to KORTIX, not to Supabase.
  //
  // This waited for `PUT .../auth/v1/user` — a direct GoTrue call from a
  // Supabase client in the browser. `useLanguage` now writes through
  // `updateProfileMetadata` -> `@kortix/sdk` -> `PATCH /v1/auth/user`, which is
  // the point of taking apps/web off the Supabase SDK. The old call is never
  // made, so the wait could only time out.
  //
  // Asserting the request as well as the result is deliberate: a locale that
  // renders correctly while persisting nowhere would still pass a
  // DOM-only check, and that is exactly the regression this guards.
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      new URL(response.url()).pathname.endsWith("/auth/user"),
  );

  const combobox = page.getByRole("combobox").first();
  await combobox.click();
  await page
    .getByRole("option", { name: nativeLocaleNames[locale], exact: true })
    .last()
    .click();

  const response = await responsePromise;
  expect(response.status()).toBe(200);
  // `{ user: … }`, the shape the route documents — GoTrue's bare user object
  // was what the Supabase call returned.
  const body = (await response.json()) as {
    user?: { user_metadata?: { locale?: string } };
  };
  expect(body.user?.user_metadata?.locale).toBe(locale);

  await expect(page.locator("html")).toHaveAttribute("lang", locale);
}

test.describe("26 — Settings localization", () => {
  test("each supported locale persists and renders settings, onboarding, and the complete route census", async ({
    page,
  }) => {
    test.setTimeout(2_700_000);

    const runId = Date.now().toString(36);
    const email = `e2e-i18n-settings-${runId}@example.test`;
    const password = "E2eI18nSettings123!";
    const supabaseUrl =
      process.env.E2E_SUPABASE_URL || "http://127.0.0.1:54321";
    const authOptions = { supabaseUrl, password };
    const user = await createAuthUser(email, authOptions);
    const session = await signIn(email, authOptions);
    const apiBase = process.env.E2E_API_URL || "http://localhost:8008/v1";
    const resultApi = createApiResultClient(apiBase);
    const jsonApi = createApiJsonClient(apiBase);
    const accountId = await resolvePersonalAccountId(
      resultApi,
      session.access_token,
    );
    const databaseUrl =
      process.env.KE2E_DATABASE_URL ||
      process.env.E2E_DATABASE_URL ||
      process.env.DATABASE_URL ||
      "";
    if (isDeployedTarget() && !databaseUrl) {
      throw new Error("A database URL is required for a deployed i18n run");
    }
    const projectName = `e2e-i18n-${runId}`;
    let project: ManifestProject | null = await createManifestProject({
      api: jsonApi,
      accessToken: session.access_token,
      accountId,
      userId: user.id,
      name: projectName,
      databaseUrl,
    });
    const projectId = project.id;
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    try {
      const appOrigin = new URL(
        process.env.E2E_BASE_URL || "http://localhost:3000",
      ).origin;
      await page.context().grantPermissions(["notifications"], {
        origin: appOrigin,
      });
      await installBrowserSessionDirect(
        page,
        session,
        `/projects/${projectId}/settings/preferences`,
        authOptions,
      );
      await expect(page.getByRole("combobox").first()).toBeVisible();
      expect(publicSurfaceRoutes).toHaveLength(24);
      expect(productSurfaceRoutes(projectId, accountId)).toHaveLength(18);

      for (const locale of locales) {
        await test.step(`${locale} persists through Supabase and renders every visible settings string`, async () => {
          const copy = messages(locale);
          const settingsSession = await signIn(email, authOptions);
          await installBrowserSessionDirect(
            page,
            settingsSession,
            `/projects/${projectId}/settings/preferences`,
            authOptions,
          );
          await expect(page.getByRole("combobox").first()).toBeVisible();
          await chooseLocale(page, locale);

          await expect(page.locator("html")).toHaveAttribute("lang", locale);
          await expect(
            page.getByRole("heading", {
              name: copy.settings.rail.projectTitle.replace(
                "{projectName}",
                projectName,
              ),
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            page.getByRole("button", { name: copy.settings.rail.backToApp }),
          ).toBeVisible();
          await expect(
            page.getByRole("navigation", { name: copy.settings.rail.settings }),
          ).toBeVisible();
          await expect(
            page.getByRole("tab", {
              name: copy.settings.rail.items.preferences.label,
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            page.getByRole("heading", {
              name: copy.settings.preferences.title,
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            page.getByRole("heading", {
              name: copy.settings.preferences.languageTitle,
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            page.getByRole("heading", {
              name: copy.settings.preferences.keyboardTitle,
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            page.getByText(copy.settings.preferences.modifierKey, {
              exact: true,
            }),
          ).toBeVisible();

          for (const shortcut of Object.values(
            copy.settings.preferences.shortcuts,
          )) {
            await expect(
              page.getByText(shortcut, { exact: true }).first(),
            ).toBeVisible();
          }

          await expect(page.getByRole("combobox").first()).toHaveText(
            nativeLocaleNames[locale],
          );

          await page
            .getByRole("tab", {
              name: copy.settings.rail.items.profile.label,
              exact: true,
            })
            .click();
          await expect(
            page.getByRole("heading", {
              name: copy.settings.rail.items.profile.label,
              exact: true,
            }),
          ).toBeVisible();
          for (const profileText of [
            copy.settings.profile.profilePicture,
            copy.settings.profile.email,
            copy.settings.profile.name,
            copy.settings.profile.organizations.title,
            copy.settings.profile.organizations.manage,
            copy.settings.profile.dangerZone,
            copy.settings.profile.deleteAccount,
          ]) {
            await expect(
              page.getByText(profileText, { exact: true }).first(),
            ).toBeVisible();
          }

          await page
            .getByRole("tab", {
              name: copy.settings.rail.items.security.label,
              exact: true,
            })
            .click();
          for (const securityText of [
            copy.settings.security.twoFactorTitle,
            copy.settings.security.authenticatorApp,
            copy.settings.security.addAuthenticatorApp,
            copy.settings.security.noFactorEnrolled,
            copy.settings.security.devices,
            copy.settings.security.signOutOtherDevices,
          ]) {
            await expect(
              page.getByText(securityText, { exact: true }).first(),
            ).toBeVisible();
          }

          await page
            .getByRole("tab", {
              name: copy.settings.rail.items.appearance.label,
              exact: true,
            })
            .click();
          for (const appearanceText of [
            copy.settings.appearance.theme,
            copy.settings.appearance.conversationDensity,
            copy.settings.appearance.wallpaper,
            copy.settings.appearance.defaultWallpaper,
            ...Object.values(copy.settings.appearance.themes),
            ...Object.values(copy.settings.appearance.densities).map(
              (density) => density.label,
            ),
          ]) {
            await expect(
              page.getByText(appearanceText, { exact: true }).first(),
            ).toBeVisible();
          }
          for (const [wallpaperId, wallpaperName] of Object.entries(
            copy.settings.appearance.wallpapers,
          )) {
            await expect(
              page.getByRole("button", {
                name:
                  wallpaperId === "dither"
                    ? `${wallpaperName} ${copy.settings.appearance.defaultWallpaper}`
                    : wallpaperName,
                exact: true,
              }),
            ).toBeVisible();
          }

          await page
            .getByRole("tab", {
              name: copy.settings.rail.items.sessions.label,
              exact: true,
            })
            .click();
          await expect(
            page.getByRole("heading", {
              name: copy.settings.sessions.notifications,
              exact: true,
              level: 2,
            }),
          ).toBeVisible();
          const notificationSwitch = page.getByRole("switch", {
            name: copy.settings.sessions.enableNotifications,
            exact: true,
          });
          if (!(await notificationSwitch.isChecked())) {
            await notificationSwitch.click();
          }
          await expect(notificationSwitch).toBeChecked();
          for (const notificationText of [
            copy.settings.sessions.notificationTypes,
            copy.settings.sessions.behavior,
            copy.settings.sessions.sendTestNotification,
            ...Object.values(copy.settings.sessions.types).flatMap((item) => [
              item.label,
              item.description,
            ]),
            ...Object.values(
              copy.settings.sessions.notificationBehavior,
            ).flatMap((item) => [item.label, item.description]),
          ]) {
            await expect(
              page.getByText(notificationText, { exact: true }).first(),
            ).toBeVisible();
          }
          await expect(
            page.getByRole("heading", {
              name: copy.settings.sessions.sounds,
              exact: true,
            }),
          ).toBeVisible();
          const defaultPack = copy.settings.sessions.soundPacks.opencode;
          await page
            .getByRole("radio", {
              name: `${defaultPack.label} ${defaultPack.description}`,
              exact: true,
            })
            .click();
          await expect(
            page.getByRole("slider", {
              name: copy.settings.sessions.volume,
              exact: true,
            }),
          ).toBeVisible();
          for (const eventCopy of Object.values(
            copy.settings.sessions.soundEvents,
          )) {
            await expect(
              page.getByText(eventCopy.label, { exact: true }).first(),
            ).toBeVisible();
            await expect(
              page.getByText(eventCopy.description, { exact: true }).first(),
            ).toBeVisible();
          }

          await page
            .getByRole("tab", {
              name: copy.settings.rail.items.tokens.label,
              exact: true,
            })
            .click();
          for (const tokenText of [
            copy.settings.tokens.emptyTitle,
            copy.settings.tokens.emptyCanCreate,
          ]) {
            await expect(
              page.getByText(tokenText, { exact: true }).first(),
            ).toBeVisible();
          }
          await expect(
            page.getByText(
              copy.settings.tokens.serviceAccountTokens.replace(
                /<\/?link>/g,
                "",
              ),
              { exact: true },
            ),
          ).toBeVisible();
          await page
            .getByRole("button", {
              name: copy.settings.tokens.newKey,
              exact: true,
            })
            .click();
          await expect(
            page.getByRole("heading", {
              name: copy.settings.tokens.createTitle,
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            page.getByRole("button", {
              name: copy.common.close,
              exact: true,
            }),
          ).toBeVisible();
          for (const tokenFormText of [
            copy.settings.tokens.createDescription,
            copy.settings.tokens.name,
            copy.settings.tokens.nameHint,
            copy.settings.tokens.scope,
            copy.settings.tokens.scopeHint,
            copy.settings.tokens.expires,
            copy.settings.tokens.expiryNever,
          ]) {
            await expect(
              page.getByText(tokenFormText, { exact: true }).first(),
            ).toBeVisible();
          }
          await expect(
            page.getByPlaceholder(copy.settings.tokens.namePlaceholder, {
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            page
              .getByRole("combobox")
              .filter({ hasText: copy.settings.tokens.wholeWorkspace }),
          ).toBeVisible();
          await expect(
            page.getByRole("button", {
              name: copy.settings.tokens.cancel,
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            page.getByRole("button", {
              name: copy.settings.tokens.createKey,
              exact: true,
            }),
          ).toBeDisabled();
          await page
            .getByRole("button", {
              name: copy.settings.tokens.cancel,
              exact: true,
            })
            .click();

          const onboardingSession = await signIn(email, authOptions);
          await installBrowserSessionDirect(
            page,
            onboardingSession,
            `/projects/${projectId}?onboarding-reset`,
            authOptions,
          );
          const wizard = page.getByRole("dialog");
          await expect(
            wizard.getByRole("heading", {
              name: copy.projectOnboarding.company.title,
              exact: true,
            }),
          ).toBeVisible({ timeout: 30_000 });
          await expect(
            wizard.getByRole("progressbar", {
              name: copy.projectOnboarding.progress,
            }),
          ).toHaveAttribute("aria-valuenow", "1");
          await expect(
            wizard.getByText(copy.projectOnboarding.company.description, {
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            wizard.getByRole("textbox", {
              name: copy.projectOnboarding.company.domain,
            }),
          ).toBeVisible();
          await wizard
            .getByRole("button", {
              name: copy.projectOnboarding.company.continue,
              exact: true,
            })
            .first()
            .click();

          await expect(
            wizard.getByRole("heading", {
              name: copy.projectOnboarding.tools.title,
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            wizard.getByRole("textbox", {
              name: copy.projectOnboarding.tools.searchPlaceholder,
            }),
          ).toBeVisible();
          await wizard
            .getByRole("button", {
              name: copy.projectOnboarding.tools.continue,
              exact: true,
            })
            .first()
            .click();

          await expect(
            wizard.getByRole("heading", {
              name: copy.projectOnboarding.slack.title,
              exact: true,
            }),
          ).toBeVisible();
          await wizard
            .getByRole("button", {
              name: copy.projectOnboarding.slack.notNow,
              exact: true,
            })
            .first()
            .click();

          await expect(
            wizard.getByRole("heading", {
              name: copy.projectOnboarding.plan.title,
              exact: true,
            }),
          ).toBeVisible();
          await wizard
            .getByRole("button", {
              name: copy.projectOnboarding.plan.continue,
              exact: true,
            })
            .first()
            .click();

          await expect(
            wizard.getByRole("heading", {
              name: copy.projectOnboarding.done.title,
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            wizard.getByText(copy.projectOnboarding.done.firstMessage, {
              exact: true,
            }),
          ).toBeVisible();
          const openProjectButton = wizard
            .getByRole("button", {
              name: copy.projectOnboarding.done.openProject,
              exact: true,
            })
            .first();
          await expect(openProjectButton).toBeVisible();
          await openProjectButton.click();
          await expect(wizard).toBeHidden();

          await page.goto("about:blank");
          await clearCookiesPreservingBypass(page.context());
          const publicPage = await page.context().newPage();
          publicPage.on("pageerror", (error) => pageErrors.push(error.message));
          try {
            for (const route of publicSurfaceRoutes) {
              await test.step(`${locale} renders ${route}`, async () => {
                const localizedRoute =
                  locale === "en"
                    ? route
                    : `/${locale}${route === "/" ? "" : route}`;
                await assertLocalizedRoute(publicPage, localizedRoute, locale);
              });
            }
          } finally {
            await publicPage.close();
          }

          for (const route of productSurfaceRoutes(projectId, accountId)) {
            await test.step(`${locale} renders ${route}`, async () => {
              const persistedSession = await signIn(email, authOptions);
              const response = await installBrowserSessionDirect(
                page,
                persistedSession,
                route,
                authOptions,
              );
              await assertLocalizedRoute(page, route, locale, response);
            });
          }

          await page.goto(`/projects/${projectId}/settings/preferences`);
          await expect(page.getByRole("combobox").first()).toBeVisible();
        });
      }

      expect(pageErrors).toEqual([]);
    } finally {
      await project?.dispose();
      project = null;
      const accounts = await queryDatabaseRows<AccountRow>(
        "select distinct account_id::text from kortix.account_members where user_id = $1::uuid",
        [user.id],
      ).catch(() => []);
      for (const account of accounts) {
        await runDatabaseSql(
          "delete from kortix.accounts where account_id = $1::uuid",
          [account.account_id],
        );
      }
      await deleteAuthUser(user.id, authOptions);
    }
  });
});
