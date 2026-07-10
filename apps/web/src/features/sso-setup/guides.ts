/**
 * Provider guides for the SSO setup wizard — Vercel-style step-by-step
 * instructions per IdP, kept as plain data so the wizard renders them and
 * tests can assert the content. The Entra guide encodes the gotchas we hit
 * setting up a real tenant (empty `mail` on onmicrosoft.com users, group
 * Object IDs vs names, P1/P2 requirements) so no admin rediscover them.
 *
 * Step kinds:
 *  - 'instructions' — things the admin does in the IdP console
 *  - 'import'       — the inline "connect to Kortix" form (metadata import)
 *  - 'scim-token'   — mint a SCIM bearer token inline (Directory Sync flow)
 *  - 'test'         — the final verify step
 */

export type StepKind = 'instructions' | 'import' | 'scim-token' | 'test';

export interface GuideStep {
  id: string;
  title: string;
  /** Lead paragraph shown under the step title. */
  intro: string;
  /** Ordered sub-instructions ("1. click X → Y"). */
  bullets?: string[];
  /** Render the copyable SP values (Entity ID + ACS URL) in this step. */
  showSpValues?: boolean;
  /** Amber callout for the sharp edges (the stuff that silently fails). */
  warning?: string;
  /** Muted footnote. */
  note?: string;
  /** Screenshot of the IdP console for this step. OUR OWN captures (from the
   *  kortixssotest test tenants) under /public/sso-setup/<provider>/ — never
   *  another vendor's doc assets. Rendered between the bullets and callouts. */
  image?: { src: string; alt: string };
  kind?: StepKind;
}

/**
 * Per-provider configuration facts. These DIFFER between IdPs and a wrong
 * default silently breaks group sync — encode them once, carefully, here:
 *
 * | provider | group claim | group VALUES               | metadata        |
 * | entra    | memberOf    | Object IDs (GUIDs)*        | hosted URL      |
 * | okta     | groups      | group names                | hosted URL      |
 * | google   | groups      | names, selected only, ≤75  | XML download    |
 *
 * (*) Entra emits display names only with "Groups assigned to the
 * application" + "Cloud-only group display names", which needs P1/P2 —
 * live-verified on a real tenant. Okta emits Okta GroupName values; Google
 * emits the names of ONLY the groups explicitly selected in the mapping.
 */
export interface ProviderConfig {
  /** Attribute name the IdP emits for groups — Kortix's group_claim_name MUST equal it. */
  groupClaimName: string;
  /** What the group VALUES look like — i.e. what an admin pastes into a group mapping. */
  groupValueHint: string;
  /** Which metadata form the IdP hands out — drives the import form's default.
   *  SAML guides set these; SCIM guides omit them (no metadata in that flow). */
  preferredMetadata?: 'url' | 'xml';
  /** Where in the IdP console the metadata lives. */
  metadataSource?: string;
  /** Placeholder for the metadata URL input (only when preferredMetadata is 'url'). */
  metadataUrlPlaceholder?: string;
}

export interface ProviderGuide {
  id: 'entra' | 'okta' | 'google' | 'custom';
  name: string;
  blurb: string;
  config: ProviderConfig;
  steps: GuideStep[];
}

/** Shared final steps — the connect + test flow is identical per provider. */
const importStep = (claimHint: string): GuideStep => ({
  id: 'connect',
  title: 'Connect to Kortix',
  kind: 'import',
  intro:
    'Paste the federation metadata from the previous step. Kortix registers your IdP and routes sign-ins for your email domain through it.',
  note: `Group claim is prefilled with ${claimHint} — it must match the claim name your IdP emits, or group sync silently finds nothing.`,
});

const testStep = (extra?: string): GuideStep => ({
  id: 'test',
  title: 'Test single sign-on',
  kind: 'test',
  intro:
    'Open the sign-in page in a private window, enter a test user’s work email, and complete the sign-in at your identity provider.',
  bullets: [
    'The user lands in Kortix as an auto-provisioned member.',
    'Their IdP groups appear under Groups (after you map them, or automatically with auto-provision).',
    'Access changes in the IdP apply on their next sign-in.',
    ...(extra ? [extra] : []),
  ],
});

export const PROVIDER_GUIDES: ProviderGuide[] = [
  {
    id: 'entra',
    name: 'Microsoft Entra ID (Azure AD)',
    blurb: 'SAML via an Entra enterprise application',
    config: {
      groupClaimName: 'memberOf',
      groupValueHint:
        'Entra sends group Object IDs (GUIDs) by default — map those GUIDs, or emit display names via "Groups assigned to the application" (needs Entra ID P1/P2).',
      preferredMetadata: 'url',
      metadataSource: 'Single sign-on → section 3 "SAML Certificates" → App Federation Metadata Url',
      metadataUrlPlaceholder:
        'https://login.microsoftonline.com/<tenant-id>/federationmetadata/2007-06/federationmetadata.xml?appid=…',
    },
    steps: [
      {
        id: 'create-app',
        title: 'Create an enterprise application',
        intro: 'Sign in to the Microsoft Entra admin center (entra.microsoft.com) as an admin of your tenant.',
        bullets: [
          'Left nav → Entra ID → Enterprise apps → New application.',
          'Choose "Create your own application".',
          'Name it (e.g. "Kortix"), select "Integrate any other application you don’t find in the gallery (Non-gallery)", and Create.',
        ],
      },
      {
        id: 'basic-saml',
        title: 'Basic SAML configuration',
        intro:
          'In the app: Single sign-on → SAML → edit "Basic SAML Configuration" and paste these two values.',
        showSpValues: true,
        bullets: [
          'Identifier (Entity ID) → the first value below (mark it Default).',
          'Reply URL (Assertion Consumer Service URL) → the second value below.',
          'Sign on URL → your Kortix sign-in page, e.g. https://app.kortix.com/auth.',
          'Leave Relay State and Logout URL empty, then Save.',
        ],
      },
      {
        id: 'email-claim',
        title: 'Fix the email claim',
        intro:
          'In "Attributes & Claims", edit the emailaddress claim and change its source attribute from user.mail to user.userprincipalname.',
        warning:
          'Entra maps email to user.mail by default, which is EMPTY for accounts without a mailbox (any *.onmicrosoft.com user). An empty email breaks sign-in with no useful error — the UPN is always populated.',
      },
      {
        id: 'group-claim',
        title: 'Add the group claim',
        intro: 'Still in "Attributes & Claims": Add a group claim, and rename it to memberOf.',
        bullets: [
          'Which groups: "Groups assigned to the application" (keeps the claim small).',
          'Source attribute: "Cloud-only group display names" for readable names.',
          'Advanced options → check "Customize the name of the group claim" → Name: memberOf.',
        ],
        warning:
          'Display names and assigning groups to the app require Entra ID P1/P2. On the Free tier pick "Security groups" + "Group ID" instead — groups arrive as Object IDs (GUIDs), and you map those GUIDs in Kortix. Both work; names are just easier to read.',
      },
      {
        id: 'assign-users',
        title: 'Assign users and groups',
        intro:
          'In the app: Users and groups → Add user/group. Only assigned users can sign in through this application.',
        note: 'Assigning a whole group (rather than individual users) requires Entra ID P1/P2.',
      },
      {
        id: 'metadata',
        title: 'Copy the federation metadata',
        intro:
          'In Single sign-on → section 3 "SAML Certificates": copy the App Federation Metadata Url (or download the Federation Metadata XML file).',
      },
      importStep('memberOf'),
      testStep('Removed from the Entra group → the mapped Kortix access is gone on next sign-in.'),
    ],
  },
  {
    id: 'okta',
    name: 'Okta',
    blurb: 'SAML via an Okta app integration',
    config: {
      groupClaimName: 'groups',
      groupValueHint:
        'Okta sends group NAMES (the Okta GroupName), exactly as they appear in the Okta admin console — map those names.',
      preferredMetadata: 'url',
      metadataSource: 'App → Sign On tab → "Identity Provider metadata" link',
      metadataUrlPlaceholder: 'https://<org>.okta.com/app/<app-id>/sso/saml/metadata',
    },
    steps: [
      {
        id: 'create-app',
        title: 'Create a SAML app integration',
        intro: 'In the Okta admin console: Applications → Applications → Create App Integration.',
        bullets: ['Sign-in method: SAML 2.0 → Next.', 'Name it (e.g. "Kortix") and continue.'],
      },
      {
        id: 'basic-saml',
        title: 'SAML settings',
        intro: 'On the "Configure SAML" step, paste these two values.',
        showSpValues: true,
        bullets: [
          'Single sign-on URL → the Reply URL (ACS) below (check "Use this for Recipient URL and Destination URL").',
          'Audience URI (SP Entity ID) → the Identifier (Entity ID) below.',
          'Name ID format: EmailAddress. Application username: Email.',
        ],
      },
      {
        id: 'email-attribute',
        title: 'Add the email attribute',
        intro:
          'Still on "Configure SAML", under "Attribute Statements" add: Name email → Value user.email.',
        note: 'Belt and braces: the NameID already carries the email, but an explicit email attribute keeps sign-in working if the NameID format ever changes.',
      },
      {
        id: 'group-claim',
        title: 'Add the group attribute',
        intro:
          'Under "Group Attribute Statements": Name groups, filter "Matches regex" with .* (or a narrower filter for just the groups you want to send).',
        note: 'Okta sends the matching groups by NAME — those names are what you map in Kortix. The attribute name (groups) is what Kortix reads as the group claim.',
      },
      {
        id: 'assign-users',
        title: 'Assign people and groups',
        intro: 'Finish the wizard, then on the app’s Assignments tab assign the users and groups that may sign in.',
      },
      {
        id: 'metadata',
        title: 'Copy the metadata URL',
        intro:
          'On the app’s Sign On tab, find the SAML Metadata / "Identity Provider metadata" link and copy its URL.',
      },
      importStep('groups'),
      testStep(),
    ],
  },
  {
    id: 'google',
    name: 'Google Workspace',
    blurb: 'SAML via a custom Google Workspace app',
    config: {
      groupClaimName: 'groups',
      groupValueHint:
        'Google sends group NAMES — and only for the groups you explicitly selected in the mapping (up to 75). A group you forgot to select is silently never sent.',
      preferredMetadata: 'xml',
      metadataSource:
        'The "Google Identity Provider details" step → Download metadata (GoogleIDPMetadata.xml). Google does not host a metadata URL.',
    },
    steps: [
      {
        id: 'create-app',
        title: 'Create a custom SAML app',
        intro: 'In the Google Admin console (admin.google.com): Apps → Web and mobile apps → Add app → Add custom SAML app.',
      },
      {
        id: 'metadata',
        title: 'Download the IdP metadata',
        intro:
          'On the "Google Identity Provider details" step, click Download metadata and keep the XML file — you’ll paste its contents into Kortix at the connect step.',
        note: 'Google only offers the XML download — there is no hosted metadata URL.',
      },
      {
        id: 'basic-saml',
        title: 'Service provider details',
        intro: 'On the "Service provider details" step, paste these two values.',
        showSpValues: true,
        bullets: [
          'ACS URL → the Reply URL (ACS) below.',
          'Entity ID → the Identifier (Entity ID) below.',
          'Name ID format: EMAIL. Name ID: Basic Information → Primary email.',
        ],
      },
      {
        id: 'group-claim',
        title: 'Map the groups attribute',
        intro:
          'On the attribute mapping step, under "Group membership (optional)" select the groups to send and set the App attribute to groups.',
        warning:
          'Google only sends groups you EXPLICITLY select here (max 75). Add every group you plan to map in Kortix — an unselected group is silently omitted from the claim.',
      },
      {
        id: 'assign-users',
        title: 'Turn the app on',
        intro: 'Back on the app page, set User access to ON for the org units or groups that may sign in.',
      },
      importStep('groups'),
      testStep(),
    ],
  },
  {
    id: 'custom',
    name: 'Custom SAML',
    blurb: 'Any SAML 2.0 identity provider',
    config: {
      groupClaimName: 'groups',
      groupValueHint:
        'Group values arrive exactly as your IdP emits them (names or IDs) — create Kortix mappings from what actually arrives.',
      preferredMetadata: 'url',
      metadataSource: 'Your IdP’s SAML metadata export (URL or XML)',
      metadataUrlPlaceholder: 'https://…/saml/metadata.xml',
    },
    steps: [
      {
        id: 'basic-saml',
        title: 'Register Kortix in your IdP',
        intro:
          'Create a SAML 2.0 application in your identity provider and give it these service-provider values.',
        showSpValues: true,
        bullets: [
          'Audience / SP Entity ID → the Identifier (Entity ID) below.',
          'ACS / Reply / Single sign-on URL → the Reply URL (ACS) below.',
          'NameID: the user’s email (EmailAddress format). Also emit an email attribute.',
          'Emit a group attribute (e.g. named groups) listing the user’s groups.',
        ],
      },
      {
        id: 'metadata',
        title: 'Get the IdP metadata',
        intro: 'Export your IdP’s SAML metadata — either a metadata URL or the raw XML.',
      },
      importStep('groups'),
      testStep(),
    ],
  },
];

export function getProviderGuide(id: string | null | undefined): ProviderGuide | null {
  if (!id) return null;
  return PROVIDER_GUIDES.find((g) => g.id === id) ?? null;
}

// ─── Directory Sync (SCIM) guides ────────────────────────────────────────────
//
// Same shape, different flow: instead of the metadata import the pivotal step
// is minting a SCIM bearer token inline ('scim-token') and pasting it + the
// Tenant URL into the IdP's provisioning screen. The Entra guide encodes the
// live-tested run: Provision on demand (P2), Block sign-in as the deactivate
// signal, and the not-yet-signed-in membership caveat.

const scimTokenStep: GuideStep = {
  id: 'token',
  title: 'Mint a SCIM token',
  kind: 'scim-token',
  intro:
    'Create the bearer token your identity provider will authenticate with, and copy the Tenant URL it posts to.',
  warning:
    'The token is shown ONCE — copy it now. To rotate later: mint a new token, update the IdP, then revoke the old one from the SCIM card.',
};

const scimTestStep = (extra?: string): GuideStep => ({
  id: 'test',
  title: 'Verify provisioning',
  kind: 'test',
  intro: 'Push a test user from your identity provider and confirm the lifecycle end to end.',
  bullets: [
    'A pushed user appears under Members (as a pending invite until their first sign-in).',
    'Deactivating the user in the IdP removes their membership and revokes their tokens.',
    'Pushed groups appear under Groups — grant them project roles to confer access.',
    ...(extra ? [extra] : []),
  ],
});

export const SCIM_PROVIDER_GUIDES: ProviderGuide[] = [
  {
    id: 'entra',
    name: 'Microsoft Entra ID (Azure AD)',
    blurb: 'Automatic provisioning from your Entra tenant',
    config: {
      groupClaimName: 'memberOf',
      groupValueHint:
        'Groups pushed via SCIM are created in Kortix under their Entra display names.',
    },
    steps: [
      {
        id: 'before',
        title: 'Before you start',
        intro:
          'Directory Sync pushes users and groups from Entra proactively — deactivations apply without waiting for a sign-in.',
        bullets: [
          'Use the same enterprise application you created for SAML SSO.',
          'Automatic provisioning requires Entra ID P1/P2 (trial works).',
          'Connect SAML SSO first so provisioned users can actually sign in.',
        ],
      },
      scimTokenStep,
      {
        id: 'connect',
        title: 'Connect provisioning in Entra',
        intro: 'In your enterprise application: Provisioning → Get started.',
        bullets: [
          'Provisioning Mode: Automatic.',
          'Tenant URL → the Tenant URL from the previous step.',
          'Secret Token → the token from the previous step.',
          'Click "Test Connection", then Save.',
        ],
        warning:
          'Paste the Tenant URL exactly as shown — it is NOT the regular API URL (no /v1 suffix). A hand-built URL is the #1 cause of a failing Test Connection.',
      },
      {
        id: 'mappings',
        title: 'Check the attribute mappings',
        intro:
          'The default mappings work. The one that matters: userName must map to the user’s email (userPrincipalName) — it is how Kortix matches accounts.',
      },
      {
        id: 'scope',
        title: 'Assign who gets provisioned',
        intro:
          'In Users and groups, assign the users/groups to provision. Keep Scope on "Sync only assigned users and groups".',
        note: 'Assigning a whole group requires Entra ID P1/P2.',
      },
      {
        id: 'provision',
        title: 'Push a test user',
        intro:
          'Use "Provision on demand" (instant, P1/P2) to push one assigned user now — or "Start provisioning" for the regular ~40-minute cycles.',
        bullets: [
          'Provision on demand → pick the user → Provision.',
          'All four stages (Import, Scope, Match, Perform action) should report Success.',
        ],
      },
      scimTestStep(
        'To deactivate from Entra: set the user’s "Block sign in" (Account enabled = off), then provision them again.',
      ),
    ],
  },
  {
    id: 'okta',
    name: 'Okta',
    blurb: 'Automatic provisioning from Okta',
    config: {
      groupClaimName: 'groups',
      groupValueHint:
        'Groups pushed via Push Groups are created in Kortix under their Okta names.',
    },
    steps: [
      {
        id: 'before',
        title: 'Before you start',
        intro: 'Use the same Okta app integration you created for SAML SSO.',
        bullets: ['Connect SAML SSO first so provisioned users can sign in.'],
      },
      scimTokenStep,
      {
        id: 'enable-scim',
        title: 'Enable SCIM on the app',
        intro: 'In the Okta admin console, open the app → General → App Settings → Edit.',
        bullets: [
          'Provisioning: SCIM → Save.',
          'A Provisioning tab appears → Configure API Integration → Enable API integration.',
          'SCIM connector base URL → the Tenant URL from the token step.',
          'Unique identifier field for users: userName.',
          'Authentication mode: HTTP Header → paste the token → Test Connector Configuration → Save.',
        ],
      },
      {
        id: 'to-app',
        title: 'Turn on the sync actions',
        intro: 'On the Provisioning tab → To App → Edit.',
        bullets: [
          'Enable Create Users, Update User Attributes, and Deactivate Users → Save.',
        ],
      },
      {
        id: 'assign',
        title: 'Assign people and push groups',
        intro:
          'Assignments → assign the people/groups to provision. Use the Push Groups tab to sync group memberships.',
      },
      scimTestStep(),
    ],
  },
  {
    id: 'custom',
    name: 'Custom SCIM 2.0',
    blurb: 'Any SCIM 2.0-capable identity provider',
    config: {
      groupClaimName: 'groups',
      groupValueHint: 'Pushed groups are created in Kortix under their displayName.',
    },
    steps: [
      scimTokenStep,
      {
        id: 'configure',
        title: 'Point your IdP at Kortix',
        intro: 'Configure your identity provider’s SCIM client with these settings.',
        bullets: [
          'Base / Tenant URL → the Tenant URL from the token step (the IdP appends /Users and /Groups).',
          'Authentication: Bearer token (the minted secret).',
          'Matching attribute: userName = the user’s email.',
          'Supported: SCIM 2.0 Users + Groups, PATCH, and `attribute eq "value"` filters. Bulk is not supported.',
        ],
      },
      scimTestStep(),
    ],
  },
];

export function getScimGuide(id: string | null | undefined): ProviderGuide | null {
  if (!id) return null;
  return SCIM_PROVIDER_GUIDES.find((g) => g.id === id) ?? null;
}
