/**
 * Provider guides for the SSO setup wizard — Vercel-style step-by-step
 * instructions per IdP, kept as plain data so the wizard renders them and
 * tests can assert the content. The Entra guide encodes the gotchas we hit
 * setting up a real tenant (empty `mail` on onmicrosoft.com users, group
 * Object IDs vs names, P1/P2 requirements) so no admin rediscover them.
 *
 * Step kinds:
 *  - 'instructions'   — things the admin does in the IdP console
 *  - 'metadata-input' — capture the IdP metadata (URL or XML) inline; the
 *                       value is stashed and prefills the import step
 *  - 'import'         — the inline "connect to Kortix" form (metadata import)
 *  - 'scim-token'     — mint a SCIM bearer token inline (Directory Sync flow)
 *  - 'test'           — the final verify step
 */

export type StepKind = 'instructions' | 'metadata-input' | 'import' | 'scim-token' | 'test';

/**
 * A schematic stand-in for a console screenshot: OUR OWN small styled panel
 * depicting the relevant fields of one Entra (or other IdP) screen — e.g. a
 * bordered box titled "Entra → Provisioning → Admin Credentials" listing
 * "Tenant URL", "Secret Token", and a "Test Connection" button. Never a copy
 * of a vendor's screenshot; StepFigure renders this whenever the real
 * screenshot file at `src` hasn't landed yet (schematic first, real
 * screenshot silently takes over once the file exists).
 */
export interface StepSchematic {
  /** The console + click path this panel represents, e.g. "Entra →
   *  Provisioning → Admin Credentials". Rendered as the panel title. */
  title: string;
  /** Labeled rows in reading order — a field, a value/placeholder, or a
   *  button, each rendered with a shape matching its `as`. */
  rows: Array<{ label: string; value?: string; as?: 'field' | 'button' | 'badge' }>;
}

/**
 * Rich step content — prose and console screenshots interleaved in reading
 * order (the Vercel/WorkOS wizard layout). Screenshots are OUR OWN captures
 * (from the kortixssotest test tenants) under /public/sso-setup/<provider>/ —
 * never another vendor's doc assets; the UI hides an image until its file
 * exists, so blocks can land before the capture run. `schematic` gives that
 * "coming soon" gap a useful placeholder instead of an empty box.
 */
export type StepBlock =
  | { kind: 'text'; text: string }
  | { kind: 'image'; src: string; alt: string; schematic?: StepSchematic }
  /** A standalone schematic panel — OUR OWN rendering of a console screen, with
   *  no backing screenshot file. Use when there is no captured PNG yet (e.g. the
   *  SCIM provider guides): unlike an `image` block with a `schematic` fallback,
   *  this references no asset, so it renders the panel directly and never trips
   *  the "every referenced screenshot must ship" guard. */
  | { kind: 'schematic'; schematic: StepSchematic }
  /** The copyable SP values (Entity ID + ACS), positioned inline. Labels are
   *  per-IdP: Entra says "Identifier (Entity ID)" / "Reply URL (ACS)", Okta
   *  says "Audience URI (SP Entity ID)" / "Single sign-on URL" — show the
   *  words the admin sees in the console. acsFirst flips the order to match
   *  the IdP form's field order. */
  | {
      kind: 'sp-values';
      entityIdLabel?: string;
      acsLabel?: string;
      acsFirst?: boolean;
      /** Also show the SP-initiated sign-on URL (the app origin + /auth) —
       *  Entra's Basic SAML Configuration has a field for it. */
      includeSignOnUrl?: boolean;
    }
  /** Claim-mapping table: Name (+Required) → Source Attribute, both copyable. */
  | {
      kind: 'claims-table';
      rows: Array<{ name: string; source: string; required?: boolean }>;
    };

export interface GuideStep {
  id: string;
  title: string;
  /** Lead paragraph shown under the step title. */
  intro: string;
  /** Rich interleaved prose/screenshot blocks, rendered after the intro. */
  content?: StepBlock[];
  /** Ordered sub-instructions ("1. click X → Y"). */
  bullets?: string[];
  /** Render the copyable SP values (Entity ID + ACS URL) in this step. */
  showSpValues?: boolean;
  /** Amber callout for the sharp edges (the stuff that silently fails) —
   *  double as the "#1 failure mode" note where relevant. */
  warning?: string;
  /** Muted footnote. */
  note?: string;
  /** Screenshot of the IdP console for this step (single-image steps). */
  image?: { src: string; alt: string; schematic?: StepSchematic };
  /** Completion-bar label, e.g. "I've created an enterprise application". */
  doneLabel?: string;
  kind?: StepKind;
  /** Which console this step happens in — rendered as a "you are here" badge
   *  so an admin never has to guess whether a step means the Kortix
   *  dashboard or the IdP's own admin center. Omit for steps not tied to a
   *  single console (e.g. pure prep/reading). */
  where?: 'kortix' | 'idp';
  /** Exact click path inside that console, e.g. "Enterprise applications →
   *  Kortix → Provisioning → Users and groups" — rendered as a breadcrumb
   *  so the admin can navigate without reading prose. */
  menuPath?: string;
  /** Short reassuring line: what success looks like once this step is done. */
  success?: string;
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
  /** SCIM guides: when the IdP pushes changes to Kortix — shown next to the
   *  "Last sync activity" indicator. We're the SCIM SERVER, so we can't know
   *  when the next call comes; this states the provider's real cadence
   *  (Entra: ~40-min scheduled cycle; most others: event-driven pushes). */
  syncCadenceHint?: string;
  /** SCIM guides: the one-liner for turning AUTOMATIC provisioning on in this
   *  IdP's console — the switch/steps after which no manual pushing is needed.
   *  Rendered on the Identity card's Setup values next to a deep link into
   *  this guide, so an admin stuck at "waiting for IdP" sees exactly what to
   *  flip without re-entering the wizard. */
  startSyncHint?: string;
}

export interface ProviderGuide {
  id:
    | 'entra'
    | 'okta'
    | 'google'
    | 'cloudflare'
    | 'onelogin'
    | 'jumpcloud'
    | 'pingone'
    | 'auth0'
    | 'custom';
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
  where: 'kortix',
  intro:
    'The federation metadata you captured earlier is prefilled below. Kortix registers your IdP and routes sign-ins for your email domain through it.',
  note: `Group claim is prefilled with ${claimHint} — it must match the claim name your IdP emits, or group sync silently finds nothing.`,
});

const testStep = (
  opts: { extra?: string; accessBullet?: string; failHint?: string } = {},
): GuideStep => ({
  id: 'test',
  title: 'Test single sign-on',
  kind: 'test',
  where: 'kortix',
  intro:
    'Copy the sign-in URL below and open it in a PRIVATE / incognito window (so your own logged-in session doesn’t auto-complete the test), enter a test user’s work email, and complete the sign-in at your identity provider.',
  bullets: [
    opts.accessBullet ??
      'The test user must be allowed to reach the app — otherwise the IdP rejects the sign-in with a “not assigned” error.',
    'On success the user lands in Kortix and appears under Members on the account’s Identity page.',
    'Groups: if you left “Auto-provision groups” ON at the connect step (the default), your IdP groups appear automatically under Groups — just grant each one a project role. If you turned it off, map them yourself on the Identity page → SAML SSO card → “Group mappings” (IdP group name/ID → Kortix group).',
    'Either way a group confers NO access until you grant it a project role; changes in the IdP (add/remove from a group) apply on the user’s next sign-in.',
    ...(opts.extra ? [opts.extra] : []),
  ],
  warning:
    opts.failHint ??
    'If the sign-in fails: “not assigned” → assign the user to the app (assign-users step); on Google this can also be propagation delay right after you turn the app on, so wait a few minutes and retry first. An attribute/email error → recheck the email claim maps to the IdP’s login attribute (attributes step). Signed in but no groups → recheck the group claim NAME matches what you set at connect.',
  success:
    'The test user shows up under Members on the Identity page — that’s a confirmed round-trip.',
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
      metadataSource:
        'Single sign-on → section 3 "SAML Certificates" → App Federation Metadata Url',
      metadataUrlPlaceholder:
        'https://login.microsoftonline.com/<tenant-id>/federationmetadata/2007-06/federationmetadata.xml?appid=…',
    },
    steps: [
      {
        id: 'create-app',
        where: 'idp',
        menuPath: 'Entra ID → Enterprise applications',
        title: 'Create an enterprise application',
        intro:
          'Sign in to the Microsoft Entra admin center (entra.microsoft.com) as an admin of your tenant.',
        content: [
          {
            kind: 'text',
            text: 'In the left navigation menu, expand the "Entra ID" section. Select the "Enterprise apps" tab. Click "New application".',
          },
          {
            kind: 'image',
            src: '/sso-setup/entra/create-app-1.png',
            alt: 'Entra admin center — Enterprise applications list with New application highlighted',
            schematic: {
              title: 'Entra ID → Enterprise applications',
              rows: [{ label: '+ New application', as: 'button' }],
            },
          },
          {
            kind: 'text',
            text: 'On the "Browse Microsoft Entra Gallery" page, click "Create your own application".',
          },
          {
            kind: 'text',
            text: 'Enter an appropriate app name, such as "Kortix". Select the "Integrate any other application you don\'t find in the gallery (Non-gallery)" option. Click "Create".',
          },
          {
            kind: 'image',
            src: '/sso-setup/entra/create-app-2.png',
            alt: 'Create your own application panel with the Non-gallery option selected',
            schematic: {
              title: 'Browse Microsoft Entra Gallery → Create your own application',
              rows: [
                { label: "What's the name of your app?", value: 'Kortix', as: 'field' },
                {
                  label:
                    "Integrate any other application you don't find in the gallery (Non-gallery)",
                  as: 'badge',
                },
                { label: 'Create', as: 'button' },
              ],
            },
          },
        ],
        doneLabel: 'I’ve created an enterprise application',
      },
      {
        id: 'basic-saml',
        where: 'idp',
        menuPath: 'Your app → Single sign-on → SAML',
        title: 'Basic SAML configuration',
        intro:
          'In the left navigation menu, select the "Single sign-on" tab. Click on the "SAML" tile.',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/entra/basic-saml-1.png',
            alt: 'Select SAML as the single sign-on method',
            schematic: {
              title: 'Single sign-on → Select a single sign-on method',
              rows: [{ label: 'SAML', as: 'badge' }],
            },
          },
          {
            kind: 'text',
            text: 'The "Set up Single Sign-On with SAML" page opens. Locate the "Basic SAML Configuration" section and click the "Edit" icon in its top right corner.',
          },
          {
            kind: 'image',
            src: '/sso-setup/entra/basic-saml-2.png',
            alt: 'Basic SAML Configuration section with the Edit button',
            schematic: {
              title: 'Set up Single Sign-On with SAML → Basic SAML Configuration',
              rows: [{ label: 'Edit', as: 'button' }],
            },
          },
          {
            kind: 'text',
            text: 'Copy the "Identifier (Entity ID)" and the "Reply URL (Assertion Consumer Service URL)" below and paste them into the "Basic SAML Configuration" panel — mark the Identifier as Default, and set "Sign on URL" to your Kortix sign-in page. Leave Relay State and Logout URL empty. Click "Save" and close the edit panel.',
          },
          { kind: 'sp-values', includeSignOnUrl: true },
          {
            kind: 'image',
            src: '/sso-setup/entra/basic-saml-3.png',
            alt: 'Basic SAML Configuration panel with the Identifier and Reply URL filled in',
            schematic: {
              title: 'Basic SAML Configuration',
              rows: [
                { label: 'Identifier (Entity ID)', value: '(pasted from below)', as: 'field' },
                {
                  label: 'Reply URL (Assertion Consumer Service URL)',
                  value: '(pasted from below)',
                  as: 'field',
                },
                { label: 'Sign on URL', value: 'https://yourapp/auth', as: 'field' },
                { label: 'Save', as: 'button' },
              ],
            },
          },
        ],
        note: 'After Save, Entra pops its own "Test single sign-on with Kortix?" dialog — choose "No, I\'ll test later". Kortix isn\'t connected yet; the guided test comes at the last step.',
        doneLabel: 'I’ve completed basic SAML configuration',
      },
      {
        id: 'email-claim',
        where: 'idp',
        menuPath: 'Single sign-on → Attributes & Claims',
        title: 'Configure attributes and claims',
        intro:
          'On the same page, locate the "Attributes & Claims" section and click the "Edit" icon in its top right corner.',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/entra/claims-1.png',
            alt: 'Attributes & Claims section with the Edit button',
            schematic: {
              title: 'Set up Single Sign-On with SAML → Attributes & Claims',
              rows: [{ label: 'Edit', as: 'button' }],
            },
          },
          {
            kind: 'text',
            text: 'Ensure the claims listed below are configured. Most exist by default — the one you almost always have to CHANGE is "emailaddress": edit it and switch its source attribute from user.mail to user.userprincipalname.',
          },
          {
            kind: 'claims-table',
            rows: [
              { name: 'emailaddress', source: 'user.userprincipalname', required: true },
              { name: 'Unique User Identifier', source: 'user.userprincipalname', required: true },
              { name: 'givenname', source: 'user.givenname' },
              { name: 'surname', source: 'user.surname' },
            ],
          },
          {
            kind: 'text',
            text: 'Below is how a claim looks in the Azure claim editor — make sure the "Namespace" value ends in /claims.',
          },
          {
            kind: 'image',
            src: '/sso-setup/entra/claims-2.png',
            alt: 'Manage claim panel showing the namespace and source attribute',
            schematic: {
              title: 'Manage claim',
              rows: [
                {
                  label: 'Namespace',
                  value: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims',
                  as: 'field',
                },
                { label: 'Source attribute', value: 'user.userprincipalname', as: 'field' },
                { label: 'Save', as: 'button' },
              ],
            },
          },
          {
            kind: 'image',
            src: '/sso-setup/entra/claims-3.png',
            alt: 'Attributes & Claims list with the configured claims',
            schematic: {
              title: 'Attributes & Claims',
              rows: [
                { label: 'emailaddress', value: 'user.userprincipalname', as: 'field' },
                { label: 'Unique User Identifier', value: 'user.userprincipalname', as: 'field' },
                { label: 'givenname', value: 'user.givenname', as: 'field' },
                { label: 'surname', value: 'user.surname', as: 'field' },
              ],
            },
          },
        ],
        warning:
          'Entra maps email to user.mail by default, which is EMPTY for accounts without a mailbox (any *.onmicrosoft.com user). An empty email breaks sign-in with no useful error. The UPN (User Principal Name — the username people sign in with, e.g. jane@yourtenant.onmicrosoft.com) is always populated, which is why every mapping here points at it.',
        doneLabel: 'I’ve configured the attributes and claims',
      },
      {
        id: 'group-claim',
        where: 'idp',
        menuPath: 'Attributes & Claims → Add a group claim',
        title: 'Add the group claim',
        intro: 'Still in "Attributes & Claims", click "Add a group claim".',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/entra/group-claim-1.png',
            alt: 'Group Claims panel in Attributes & Claims',
            schematic: {
              title: 'Group Claims',
              rows: [
                {
                  label: 'Which groups associated with the user should be returned in the claim?',
                  value: 'Groups assigned to the application',
                  as: 'field',
                },
                { label: 'Source attribute', value: 'Cloud-only group display names', as: 'field' },
                {
                  label: 'Advanced options → Customize the name of the group claim',
                  value: 'memberOf',
                  as: 'field',
                },
                { label: 'Save', as: 'button' },
              ],
            },
          },
        ],
        bullets: [
          'Which groups: "Groups assigned to the application" (keeps the claim small).',
          'Source attribute: "Cloud-only group display names" for readable names.',
          'Advanced options → check "Customize the name of the group claim" → Name: memberOf.',
        ],
        warning:
          'Display names and assigning groups to the app require Entra ID P1/P2 (check yours: Entra admin center → Overview → the License row). On the Free tier pick "Security groups" + "Group ID" instead — groups arrive as Object IDs (GUIDs; copy a group\'s Object ID from Entra ID → Groups) and you map those GUIDs in Kortix. EITHER WAY, you must still rename the claim to memberOf under "Advanced options" → "Customize the name of the group claim" — skipping the rename is the #1 cause of groups silently not syncing.',
        doneLabel: 'I’ve added the memberOf group claim',
      },
      {
        id: 'assign-users',
        where: 'idp',
        menuPath: 'Your app → Users and groups',
        title: 'Assign users and groups',
        intro:
          'In the left navigation menu, select "Users and groups". Only assigned users can sign in through this application.',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/entra/assign-users-1.png',
            alt: 'Users and groups in the Manage section',
            schematic: {
              title: 'Manage → Users and groups',
              rows: [{ label: '+ Add user/group', as: 'button' }],
            },
          },
          {
            kind: 'text',
            text: 'Click "Add user/group", click "None Selected" under Users and groups, select the users or groups that should sign in to Kortix, click "Select", then click "Assign".',
          },
          {
            kind: 'image',
            src: '/sso-setup/entra/assign-users-2.png',
            alt: 'Selecting users and groups to assign to the application',
            schematic: {
              title: 'Add Assignment',
              rows: [
                { label: 'Users', value: 'None Selected', as: 'field' },
                { label: 'Assign', as: 'button' },
              ],
            },
          },
        ],
        note: 'Assigning a whole group (rather than individual users) requires Entra ID P1/P2.',
        doneLabel: 'I’ve assigned users to the application',
      },
      {
        id: 'metadata',
        where: 'idp',
        menuPath: 'Single sign-on → SAML Certificates',
        title: 'Set identity provider metadata',
        kind: 'metadata-input',
        intro:
          'In "Single sign-on", scroll to section 3 "SAML Certificates" and copy the "App Federation Metadata Url". Paste it below to continue.',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/entra/metadata-1.png',
            alt: 'SAML Certificates section with the App Federation Metadata Url',
            schematic: {
              title: 'Set up Single Sign-On with SAML → SAML Certificates',
              rows: [
                {
                  label: 'App Federation Metadata Url',
                  value: 'https://login.microsoftonline.com/…/federationmetadata.xml?appid=…',
                  as: 'field',
                },
              ],
            },
          },
        ],
        doneLabel: 'I’ve added the identity provider metadata URL',
      },
      importStep('memberOf'),
      testStep({
        extra: 'Removed from the Entra group → the mapped Kortix access is gone on next sign-in.',
      }),
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
        title: 'Create a SAML integration',
        intro: 'Sign in to the Okta admin console.',
        content: [
          {
            kind: 'text',
            text: 'In the left navigation menu, expand the "Applications" section and select the "Applications" tab.',
          },
          {
            kind: 'image',
            src: '/sso-setup/okta/create-app-1.png',
            alt: 'Okta admin console with the Applications section expanded',
            schematic: {
              title: 'Applications → Applications',
              rows: [{ label: 'Create App Integration', as: 'button' }],
            },
          },
          { kind: 'text', text: 'Click "Create App Integration".' },
          {
            kind: 'image',
            src: '/sso-setup/okta/create-app-2.png',
            alt: 'Applications page with the Create App Integration button',
            schematic: {
              title: 'Applications',
              rows: [{ label: 'Create App Integration', as: 'button' }],
            },
          },
          {
            kind: 'text',
            text: 'In the "Create a new app integration" dialog, select "SAML 2.0". Click "Next".',
          },
          {
            kind: 'image',
            src: '/sso-setup/okta/create-app-3.png',
            alt: 'Create a new app integration dialog with SAML 2.0 selected',
            schematic: {
              title: 'Create a new app integration',
              rows: [
                { label: 'Sign-in method', value: 'SAML 2.0', as: 'field' },
                { label: 'Next', as: 'button' },
              ],
            },
          },
          {
            kind: 'text',
            text: 'The "Create SAML Integration" wizard opens. On the "General Settings" step, enter an appropriate app name, such as "Kortix" — optionally upload an app logo. Click "Next".',
          },
          {
            kind: 'image',
            src: '/sso-setup/okta/create-app-4.png',
            alt: 'General Settings step with the app name field',
            schematic: {
              title: 'Create SAML Integration → General Settings',
              rows: [
                { label: 'App name', value: 'Kortix', as: 'field' },
                { label: 'App logo (optional)', as: 'field' },
                { label: 'Next', as: 'button' },
              ],
            },
          },
        ],
        note: 'On the wizard\'s last step ("Help Okta Support understand how you configured this application"), select "This is an internal app that we have created" and click "Finish" — it\'s just Okta\'s own telemetry question, not a Kortix setting.',
        doneLabel: 'I’ve created a SAML app integration',
      },
      {
        id: 'basic-saml',
        title: 'Configure SAML',
        intro:
          'On the "Configure SAML" step, locate the "Single sign-on URL" and "Audience URI (SP Entity ID)" fields. Copy the values below and paste them into their respective fields.',
        content: [
          {
            kind: 'sp-values',
            acsLabel: 'Single sign-on URL',
            entityIdLabel: 'Audience URI (SP Entity ID)',
            acsFirst: true,
          },
          {
            kind: 'image',
            src: '/sso-setup/okta/basic-saml-1.png',
            alt: 'Configure SAML step with the Single sign-on URL and Audience URI fields',
            schematic: {
              title: 'Create SAML Integration → Configure SAML',
              rows: [
                { label: 'Single sign-on URL', value: '(pasted from below)', as: 'field' },
                { label: 'Audience URI (SP Entity ID)', value: '(pasted from below)', as: 'field' },
              ],
            },
          },
          {
            kind: 'text',
            text: 'Check "Use this for Recipient URL and Destination URL". Set "Name ID format" to EmailAddress and "Application username" to Email — Kortix matches accounts by email.',
          },
          {
            kind: 'image',
            src: '/sso-setup/okta/basic-saml-2.png',
            alt: 'Name ID format and Application username settings',
            schematic: {
              title: 'Configure SAML → Name ID format',
              rows: [
                { label: 'Name ID format', value: 'EmailAddress', as: 'field' },
                { label: 'Application username', value: 'Email', as: 'field' },
              ],
            },
          },
        ],
        doneLabel: 'I’ve configured the SAML settings',
      },
      {
        id: 'email-attribute',
        title: 'Configure SAML attributes',
        intro:
          'Return to the application (Applications → your app) and make sure the "Sign On" tab is selected.',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/okta/email-attribute-1.png',
            alt: 'Application settings page with the Sign On tab selected',
            schematic: {
              title: 'Your app → Sign On',
              rows: [{ label: 'Show legacy configuration', as: 'button' }],
            },
          },
          {
            kind: 'text',
            text: 'Click "Show legacy configuration" to expand it, then click "Edit" next to "Profile attribute statements".',
          },
          {
            kind: 'image',
            src: '/sso-setup/okta/email-attribute-2.png',
            alt: 'Show legacy configuration expanded with profile and group attribute statements',
            schematic: {
              title: 'Sign On → Legacy configuration',
              rows: [
                { label: 'Profile attribute statements', as: 'badge' },
                { label: 'Group attribute statements', as: 'badge' },
                { label: 'Edit', as: 'button' },
              ],
            },
          },
          { kind: 'text', text: 'Create the following attribute mapping statements:' },
          {
            kind: 'claims-table',
            rows: [
              { name: 'email', source: 'user.email', required: true },
              { name: 'firstName', source: 'user.firstName' },
              { name: 'lastName', source: 'user.lastName' },
            ],
          },
          { kind: 'text', text: 'In the end, it should look like this. Click "Save".' },
          {
            kind: 'image',
            src: '/sso-setup/okta/email-attribute-3.png',
            alt: 'Profile attribute statements filled with email, firstName, and lastName',
            schematic: {
              title: 'Profile attribute statements',
              rows: [
                { label: 'email', value: 'user.email', as: 'field' },
                { label: 'firstName', value: 'user.firstName', as: 'field' },
                { label: 'lastName', value: 'user.lastName', as: 'field' },
                { label: 'Save', as: 'button' },
              ],
            },
          },
        ],
        note: 'Belt and braces: the NameID already carries the email, but an explicit email attribute keeps sign-in working if the NameID format ever changes.',
        doneLabel: 'I’ve configured the SAML attributes',
      },
      {
        id: 'group-claim',
        title: 'Add the group attribute',
        intro:
          'In the same "Show legacy configuration" panel, under "Group attribute statements", add: Name groups, filter "Matches regex" with .* (or a narrower filter for just the groups you want to send). Click "Save".',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/okta/group-claim-1.png',
            alt: 'Group attribute statements form below the profile attribute statements',
            schematic: {
              title: 'Group attribute statements',
              rows: [
                { label: 'Name', value: 'groups', as: 'field' },
                { label: 'Filter', value: 'Matches regex  .*', as: 'field' },
                { label: 'Save', as: 'button' },
              ],
            },
          },
        ],
        note: 'Okta sends the matching groups by NAME — those names are what you map in Kortix. The attribute name (groups) is what Kortix reads as the group claim.',
        doneLabel: 'I’ve added the groups attribute',
      },
      {
        id: 'assign-users',
        title: 'Assign groups to the SAML app',
        intro:
          'On the application settings page, select the "Assignments" tab. Click "Assign" and select "Assign to Groups" (or "Assign to People" for individual users).',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/okta/assign-users-1.png',
            alt: 'Assignments tab with the Assign dropdown open',
            schematic: {
              title: 'Your app → Assignments',
              rows: [
                { label: 'Assign to People', as: 'button' },
                { label: 'Assign to Groups', as: 'button' },
              ],
            },
          },
          {
            kind: 'text',
            text: 'Assign the appropriate groups to the application. When you are finished, click "Done". Only assigned users can sign in through this application.',
          },
          {
            kind: 'image',
            src: '/sso-setup/okta/assign-users-2.png',
            alt: 'Assign to Groups dialog with groups being assigned',
            schematic: {
              title: 'Assign Group to App',
              rows: [
                { label: 'Search', value: 'Engineers', as: 'field' },
                { label: 'Done', as: 'button' },
              ],
            },
          },
        ],
        doneLabel: 'I’ve assigned users and groups',
      },
      {
        id: 'metadata',
        title: 'Set identity provider metadata',
        kind: 'metadata-input',
        intro:
          'On the app’s "Sign On" tab, in the "Metadata details" section, locate the "Metadata URL" and click "Copy". Paste it below to continue.',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/okta/metadata-1.png',
            alt: 'Sign On tab with the Metadata URL and Copy button',
            schematic: {
              title: 'Your app → Sign On → Metadata details',
              rows: [
                {
                  label: 'Metadata URL',
                  value: 'https://<org>.okta.com/app/<app-id>/sso/saml/metadata',
                  as: 'field',
                },
                { label: 'Copy', as: 'button' },
              ],
            },
          },
        ],
        doneLabel: 'I’ve added the identity provider metadata URL',
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
        where: 'idp',
        menuPath: 'Google Admin → Apps → Web and mobile apps',
        title: 'Create a custom SAML app',
        intro:
          'In the Google Admin console (admin.google.com): Apps → Web and mobile apps → Add app → Add custom SAML app.',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/google/create-app-1.png',
            alt: 'Google Admin console Web and mobile apps page with Add app menu open',
            schematic: {
              title: 'Apps → Web and mobile apps',
              rows: [{ label: 'Add app → Add custom SAML app', as: 'button' }],
            },
          },
          {
            kind: 'text',
            text: 'Enter an app name, such as "Kortix" — optionally upload an app icon. Click "Continue".',
          },
          {
            kind: 'image',
            src: '/sso-setup/google/create-app-2.png',
            alt: 'Google custom SAML app dialog with the App name and icon fields',
            schematic: {
              title: 'Add custom SAML app → App details',
              rows: [
                { label: 'App name', value: 'Kortix', as: 'field' },
                { label: 'App icon', value: '(optional)', as: 'field' },
                { label: 'Continue', as: 'button' },
              ],
            },
          },
        ],
        doneLabel: 'I’ve created a custom SAML app',
      },
      {
        id: 'metadata',
        where: 'idp',
        menuPath: 'Add custom SAML app → Google Identity Provider details',
        title: 'Set identity provider metadata',
        kind: 'metadata-input',
        intro:
          'On the "Google Identity Provider details" step, click "Download metadata", paste the XML file’s contents below, then click "Continue" IN GOOGLE to open the "Service provider details" screen (the next step).',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/google/metadata-1.png',
            alt: 'Google Identity Provider details step with the Download metadata button',
            schematic: {
              title: 'Add custom SAML app → Google Identity Provider details',
              rows: [
                { label: 'Download metadata', as: 'button' },
                { label: 'Continue', as: 'button' },
              ],
            },
          },
        ],
        note: "Google only offers the XML download — there is no hosted metadata URL. Come back to re-download it if you change the app's configuration later; Kortix reads whatever is in the file at import time.",
        doneLabel: 'I’ve added the identity provider metadata',
      },
      {
        id: 'basic-saml',
        where: 'idp',
        menuPath: 'Add custom SAML app → Service provider details',
        title: 'Service provider details',
        intro: 'On the "Service provider details" step, paste these two values.',
        content: [
          {
            kind: 'sp-values',
            acsLabel: 'ACS URL',
            entityIdLabel: 'Entity ID',
            acsFirst: true,
          },
          {
            kind: 'image',
            src: '/sso-setup/google/basic-saml-1.png',
            alt: 'Service provider details step with ACS URL and Entity ID fields',
            schematic: {
              title: 'Service provider details',
              rows: [
                { label: 'ACS URL', value: '(pasted from below)', as: 'field' },
                { label: 'Entity ID', value: '(pasted from below)', as: 'field' },
                { label: 'Name ID format', value: 'EMAIL', as: 'field' },
                { label: 'Name ID', value: 'Basic Information > Primary email', as: 'field' },
                { label: 'Continue', as: 'button' },
              ],
            },
          },
        ],
        bullets: [
          'ACS URL → the Reply URL (ACS) below.',
          'Entity ID → the Identifier (Entity ID) below.',
          'Name ID format: EMAIL. Name ID: Basic Information → Primary email.',
        ],
      },
      {
        id: 'attribute-mapping',
        where: 'idp',
        menuPath: 'Add custom SAML app → Attribute mapping',
        title: 'Map user attributes',
        intro:
          'On the "Attribute mapping" step, click "Add mapping" for each row: pick the Google Directory field on the LEFT, and type the App attribute name (primaryEmail / firstName / lastName) on the RIGHT. In the end it should look like this:',
        content: [
          {
            kind: 'claims-table',
            rows: [
              { name: 'primaryEmail', source: 'Basic Information > Primary email', required: true },
              { name: 'firstName', source: 'Basic Information > First name' },
              { name: 'lastName', source: 'Basic Information > Last name' },
            ],
          },
          {
            kind: 'image',
            src: '/sso-setup/google/attribute-mapping-1.png',
            alt: 'Google custom SAML app Attribute mapping step with primaryEmail, firstName and lastName mapped',
            schematic: {
              title: 'Attribute mapping',
              rows: [
                { label: 'Primary email', value: '→ primaryEmail', as: 'field' },
                { label: 'First name', value: '→ firstName', as: 'field' },
                { label: 'Last name', value: '→ lastName', as: 'field' },
              ],
            },
          },
        ],
        doneLabel: 'I’ve mapped the user attributes',
      },
      {
        id: 'group-claim',
        where: 'idp',
        menuPath: 'Attribute mapping → Group membership',
        title: 'Map the groups attribute',
        intro:
          'Still on the attribute mapping step, scroll to "Group membership (optional)", click "Add Google groups", select the groups to send, and set the "App attribute" to groups. Click "Finish".',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/google/group-claim-1.png',
            alt: 'Attribute mapping step Group membership section with the groups app attribute',
            schematic: {
              title: 'Attribute mapping → Group membership (optional)',
              rows: [
                { label: 'Google groups', value: 'Engineers, Support, …', as: 'field' },
                { label: 'App attribute', value: 'groups', as: 'field' },
                { label: 'Finish', as: 'button' },
              ],
            },
          },
        ],
        warning:
          'Google only sends groups you EXPLICITLY select here (max 75). Add every group you plan to map in Kortix — an unselected group is silently omitted from the claim.',
      },
      {
        id: 'assign-users',
        where: 'idp',
        menuPath: 'Your app → User access',
        title: 'Turn the app on',
        intro:
          'Back on the app page, select "User access", set the service to ON for the org units or groups that may sign in, then click "Save".',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/google/assign-users-1.png',
            alt: 'App page User access section with the service toggle',
            schematic: {
              title: 'Kortix → User access',
              rows: [
                {
                  label: 'Service status',
                  value: 'ON for everyone / ON for some organizational units',
                  as: 'field',
                },
                { label: 'Save', as: 'button' },
              ],
            },
          },
        ],
        note: 'Google can take up to 24 hours to fully propagate an access change — a user reporting "not assigned" right after you flip this on may just need to wait.',
        doneLabel: 'I’ve turned the app on for the right users',
      },
      importStep('groups'),
      testStep(),
    ],
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare Access',
    blurb: 'SAML brokered through Cloudflare Zero Trust',
    config: {
      groupClaimName: 'groups',
      groupValueHint:
        'Cloudflare forwards the upstream IdP’s group NAMES on a "groups" SAML attribute (sent automatically for Okta, Entra ID, Google Workspace, and GitHub) — map those names in Kortix.',
      preferredMetadata: 'url',
      metadataSource:
        'Take the "SSO endpoint" Cloudflare shows for the app and append /saml-metadata to it — that URL serves the SAML metadata XML.',
      metadataUrlPlaceholder:
        'https://<your-team>.cloudflareaccess.com/cdn-cgi/access/sso/saml/<app-id>/saml-metadata',
    },
    steps: [
      {
        id: 'before',
        title: 'Connect Cloudflare Access to your identity provider',
        where: 'idp',
        menuPath: 'Cloudflare Zero Trust → Settings → Authentication → Login methods',
        intro:
          'Cloudflare Access sits BETWEEN Kortix and your real identity provider: it authenticates users against your IdP, then presents itself to Kortix as a SAML IdP. So set up the upstream connection first — in Zero Trust → Settings → Authentication, add a login method (Okta, Entra, Google, …) per Cloudflare’s docs.',
        bullets: [
          'This guide covers the DOWNSTREAM half (Cloudflare → Kortix). The upstream half (your IdP → Cloudflare) follows Cloudflare’s own documentation for your provider.',
          'Whatever attributes Kortix needs (email, first/last name, and groups) must survive the upstream hop — Cloudflare forwards them on.',
        ],
        doneLabel: 'Cloudflare Access is connected to my IdP',
      },
      {
        id: 'add-app',
        title: 'Add a SaaS application in Cloudflare Access',
        where: 'idp',
        menuPath: 'Zero Trust → Access → Applications → Add an application',
        intro: 'In Cloudflare Zero Trust: Access → Applications → "Add an application".',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/cloudflare/add-app-1.png',
            alt: 'Cloudflare Zero Trust Access Applications page with Add an application',
            schematic: {
              title: 'Access → Applications',
              rows: [{ label: 'Add an application', as: 'button' }],
            },
          },
          {
            kind: 'text',
            text: 'Choose the "SaaS" application type, then select SAML (not OIDC) as the protocol. Give it a name such as "Kortix".',
          },
          {
            kind: 'image',
            src: '/sso-setup/cloudflare/add-app-2.png',
            alt: 'Cloudflare Add an application dialog with the SaaS type selected',
            schematic: {
              title: 'Add an application → Select type',
              rows: [
                { label: 'SaaS', as: 'button' },
                { label: 'Protocol', value: 'SAML', as: 'field' },
              ],
            },
          },
        ],
        doneLabel: 'I’ve added a SaaS SAML application',
      },
      {
        id: 'basic-saml',
        title: 'Service provider details',
        where: 'idp',
        menuPath: 'Add an application → SaaS · SAML → app configuration',
        intro:
          'You configure everything in Cloudflare’s single “Add an application” wizard (the Configuration / Authentication / Policies / Overview tabs only appear when you EDIT the app later). First, paste Kortix’s service-provider values into Cloudflare’s fields.',
        content: [
          {
            kind: 'sp-values',
            acsLabel: 'Assertion Consumer Service URL',
            entityIdLabel: 'Entity ID',
            acsFirst: true,
          },
          {
            kind: 'image',
            src: '/sso-setup/cloudflare/basic-saml-1.png',
            alt: 'Cloudflare SaaS SAML app configuration with Entity ID and ACS URL fields',
            schematic: {
              title: 'SaaS app → Configuration',
              rows: [
                { label: 'Entity ID', value: '(pasted from below)', as: 'field' },
                {
                  label: 'Assertion Consumer Service URL',
                  value: '(pasted from below)',
                  as: 'field',
                },
                { label: 'Name ID format', value: 'Email', as: 'field' },
              ],
            },
          },
          {
            kind: 'text',
            text: 'Set "Name ID format" to Email — Kortix correlates accounts by email address.',
          },
        ],
        doneLabel: 'I’ve entered the service-provider details',
      },
      {
        id: 'attributes',
        title: 'Configure SAML attributes',
        where: 'idp',
        menuPath: 'Add an application → SaaS · SAML → SAML attribute statements',
        intro:
          'Cloudflare Access passes email by default. Add the other attributes Kortix reads — id, firstName, lastName — as "SAML attribute statements": each is a Name plus the upstream IdP claim it maps to (a dropdown of your login method’s claims).',
        content: [
          {
            kind: 'claims-table',
            rows: [
              { name: 'email', source: 'passed by default', required: true },
              { name: 'id', source: 'the upstream user-id claim', required: true },
              { name: 'firstName', source: 'the upstream first-name claim' },
              { name: 'lastName', source: 'the upstream last-name claim' },
            ],
          },
          {
            kind: 'image',
            src: '/sso-setup/cloudflare/attributes-1.png',
            alt: 'Cloudflare SaaS app SAML attributes section with id, firstName, lastName added',
            schematic: {
              title: 'Configuration → SAML attributes',
              rows: [
                { label: 'Name', value: 'id · IdP claim: user id', as: 'field' },
                { label: 'Name', value: 'firstName · IdP claim: first name', as: 'field' },
                { label: 'Name', value: 'lastName · IdP claim: last name', as: 'field' },
                { label: 'Add attribute', as: 'button' },
              ],
            },
          },
        ],
        doneLabel: 'I’ve added the SAML attributes',
      },
      {
        id: 'group-claim',
        title: 'Confirm the groups attribute',
        where: 'idp',
        menuPath: 'Add an application → SaaS · SAML → SAML attribute statements',
        intro:
          'For Okta, Microsoft Entra ID, Google Workspace, and GitHub, Cloudflare Access sends a "groups" SAML attribute automatically — there is nothing to add here, just confirm it is present. For any other upstream IdP, add one SAML attribute statement with Name "groups" and pick the IdP claim that carries group membership.',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/cloudflare/group-claim-1.png',
            alt: 'Cloudflare SAML attribute statements showing the groups attribute',
            schematic: {
              title: 'SAML attribute statements',
              rows: [
                { label: 'Name', value: 'groups', as: 'field' },
                { label: 'IdP claim', value: 'the upstream group-membership claim', as: 'field' },
              ],
            },
          },
        ],
        warning:
          'Do NOT enable the Advanced settings "SAML attribute transform (JSONata)" to build groups — a JSONata transform OVERRIDES all your SAML attribute statements, wiping out the email/id/firstName/lastName mappings from the previous step. Use plain attribute statements only.',
        note: 'The attribute name (groups) must match Kortix’s group claim, which is prefilled at the connect step. Cloudflare passes through whatever group NAMES the upstream IdP sends.',
        doneLabel: 'I’ve confirmed the groups attribute',
      },
      {
        id: 'login-methods',
        title: 'Configure login methods',
        where: 'idp',
        menuPath: 'Add an application → SaaS · SAML → identity providers',
        intro:
          'Choose which identity provider(s) this application accepts — the upstream login method(s) you set up in the first step. Restrict to the one(s) you intend, or allow all configured methods.',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/cloudflare/login-methods-1.png',
            alt: 'Cloudflare selecting the identity provider login methods for the app',
            schematic: {
              title: 'App → Authentication → Login methods',
              rows: [{ label: 'Identity providers', value: 'Okta / Entra / …', as: 'field' }],
            },
          },
        ],
        doneLabel: 'I’ve chosen the login methods',
      },
      {
        id: 'policy',
        title: 'Add an access policy',
        where: 'idp',
        menuPath: 'Add an application → SaaS · SAML → policies',
        intro:
          'Cloudflare requires at least one Access policy or NOBODY can reach the app. Add a policy that allows the users/groups who may sign in (e.g. Action: Allow, Include: Emails ending in your domain, or a specific group).',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/cloudflare/policy-1.png',
            alt: 'Cloudflare Access policy configuration with rules',
            schematic: {
              title: 'App → Policies → Add a policy',
              rows: [
                { label: 'Action', value: 'Allow', as: 'field' },
                { label: 'Include', value: 'Emails ending in @yourdomain / a group', as: 'field' },
              ],
            },
          },
        ],
        warning:
          'No policy = a locked door: Cloudflare denies everyone until at least one Allow policy exists. This is the most common "SSO redirects but access is denied" cause.',
        doneLabel: 'I’ve added an access policy',
      },
      {
        id: 'metadata',
        title: 'Set identity provider metadata',
        kind: 'metadata-input',
        where: 'idp',
        menuPath: 'SaaS app → Overview → SAML Metadata endpoint',
        intro:
          'When you finish the "Add an application" form, Cloudflare shows the app’s SSO endpoint, Access Entity ID, and public key. Copy the "SSO endpoint" value and append /saml-metadata to it — that URL serves the metadata XML. Paste the full URL below to continue.',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/cloudflare/metadata-1.png',
            alt: 'Cloudflare SaaS app credentials with the SSO endpoint, Access Entity ID and public key',
            schematic: {
              title: 'Add an application → app credentials',
              rows: [
                { label: 'SSO endpoint', value: 'https://<team>…/sso/saml/<app-id>', as: 'field' },
                { label: '+ /saml-metadata', value: '→ paste this full URL', as: 'field' },
                { label: 'Access Entity ID', value: '(issuer)', as: 'field' },
              ],
            },
          },
        ],
        note: 'Prefer to paste XML? Open the SSO endpoint URL with /saml-metadata appended in a browser and paste the returned EntityDescriptor XML into the Manual option above.',
        doneLabel: 'I’ve added the identity provider metadata',
      },
      importStep('groups'),
      testStep({
        accessBullet:
          'The test user must be allowed by your Access policy (Cloudflare has no per-user app assignment) — a denied sign-in almost always means the policy is missing or too narrow.',
        failHint:
          'If the sign-in fails: “access denied” by Cloudflare → widen or add an Access policy (the policy step). Bounced at the IdP → check the upstream login method (the first step). Signed in but no groups → confirm the “groups” attribute is present (group step) and its NAME matches the connect step.',
      }),
    ],
  },
  {
    id: 'onelogin',
    name: 'OneLogin',
    blurb: 'SAML via a OneLogin custom connector app',
    config: {
      groupClaimName: 'groups',
      groupValueHint:
        'OneLogin sends the user’s Role names on the "groups" parameter — map those names in Kortix. The parameter MUST be flagged multi-value, or OneLogin collapses every role into one string.',
      preferredMetadata: 'url',
      metadataSource:
        'The app’s SSO tab → Issuer URL (a hosted metadata link) — or download the same XML via More Actions → SAML Metadata.',
      metadataUrlPlaceholder: 'https://<subdomain>.onelogin.com/saml/metadata/<app-id>',
    },
    steps: [
      {
        id: 'create-app',
        title: 'Open the SAML connector app',
        where: 'idp',
        menuPath: 'OneLogin admin → Applications → Applications',
        intro:
          'In the OneLogin admin console: Applications → Applications → "Add App" (top-right) → search the catalog for "SAML Custom Connector (Advanced)" → select it → set the Display Name to "Kortix" → Save.',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/onelogin/create-app-1.png',
            alt: 'OneLogin Applications list with the SAML connector app',
            schematic: {
              title: 'Applications → Add App',
              rows: [
                { label: 'Search', value: 'SAML Custom Connector (Advanced)', as: 'field' },
                { label: 'Display Name', value: 'Kortix', as: 'field' },
                { label: 'Save', as: 'button' },
              ],
            },
          },
          {
            kind: 'text',
            text: 'The Configuration / Parameters / SSO tabs only appear AFTER that first Save — save the app once, then reopen it to configure.',
          },
        ],
        doneLabel: 'I’ve created the SAML connector app',
      },
      {
        id: 'basic-saml',
        title: 'Configuration',
        where: 'idp',
        menuPath: 'Your app → Configuration',
        intro:
          'On the Configuration tab, paste Kortix’s values. Note OneLogin uses several fields for the ACS URL.',
        content: [
          {
            kind: 'sp-values',
            acsLabel: 'Recipient (ACS URL)',
            entityIdLabel: 'Audience (EntityID)',
            acsFirst: true,
          },
          {
            kind: 'image',
            src: '/sso-setup/onelogin/basic-saml-1.png',
            alt: 'OneLogin Configuration tab with Audience, Recipient and ACS URL fields',
            schematic: {
              title: 'Configuration',
              rows: [
                { label: 'Audience (EntityID)', value: '(Entity ID below)', as: 'field' },
                { label: 'Recipient', value: '(ACS URL below)', as: 'field' },
                { label: 'ACS (Consumer) URL', value: '(ACS URL below)', as: 'field' },
                {
                  label: 'ACS (Consumer) URL Validator',
                  value: 'regex matching the ACS URL',
                  as: 'field',
                },
              ],
            },
          },
          {
            kind: 'text',
            text: 'Put the ACS URL in both "Recipient" and "ACS (Consumer) URL". The "ACS (Consumer) URL Validator" is a REGEX field, not a plain URL: take the ACS URL above, escape every dot (. becomes \\.), and anchor it with ^ … $. For example, if the ACS URL is https://api.kortix.com/auth/v1/sso/saml/acs, paste ^https:\\/\\/api\\.kortix\\.com\\/auth\\/v1\\/sso\\/saml\\/acs$ — a pattern that doesn’t match the exact ACS URL makes the sign-in fail with no clear error.',
          },
        ],
        warning:
          '#1 OneLogin gotcha: the "ACS (Consumer) URL Validator" is a regex, not a plain URL. Escape the dots and anchor it so it matches the ACS URL exactly, or login fails with no clear error.',
        doneLabel: 'I’ve filled in the configuration',
      },
      {
        id: 'attributes',
        title: 'Map parameters',
        where: 'idp',
        menuPath: 'Your app → Parameters',
        intro:
          'On the Parameters tab, add a SAML parameter for each attribute and map it to its OneLogin value from the dropdown. Tick "Include in SAML assertion" on every one, or the value is never sent.',
        content: [
          {
            kind: 'claims-table',
            rows: [
              { name: 'email', source: 'Email', required: true },
              { name: 'id', source: 'UUID (the OneLogin user id)', required: true },
              { name: 'firstName', source: 'First Name' },
              { name: 'lastName', source: 'Last Name' },
            ],
          },
          {
            kind: 'image',
            src: '/sso-setup/onelogin/attributes-1.png',
            alt: 'OneLogin mapping a parameter to its value with Include in SAML assertion',
            schematic: {
              title: 'Parameters → Include in SAML assertion',
              rows: [
                { label: 'Field name', value: 'email / id / firstName / lastName', as: 'field' },
                { label: 'Value', value: 'Email / UUID / First Name / Last Name', as: 'field' },
                { label: 'Include in SAML assertion', value: 'checked', as: 'field' },
              ],
            },
          },
        ],
        doneLabel: 'I’ve mapped the parameters',
      },
      {
        id: 'group-claim',
        title: 'Add the groups parameter',
        where: 'idp',
        menuPath: 'Your app → Parameters',
        intro:
          'Add one more parameter with Field name "groups". In its Value dropdown pick "User Roles" (that is the entry that emits the user’s role names — OneLogin’s separate "Groups" concept is a different attribute). Tick "Include in SAML assertion", AND enable the multi-value flag so every role is sent as its own value.',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/onelogin/group-claim-1.png',
            alt: 'OneLogin groups parameter with the multi-value flag enabled',
            schematic: {
              title: 'Parameters → groups',
              rows: [
                { label: 'Field name', value: 'groups', as: 'field' },
                { label: 'Value', value: 'User Roles', as: 'field' },
                { label: 'Multi-value parameter', value: 'checked', as: 'field' },
              ],
            },
          },
        ],
        warning:
          'Without the multi-value flag OneLogin collapses all roles into one delimited string — group sync then sees a single junk "group". Always enable it.',
        note: 'The parameter name (groups) must match Kortix’s group claim, prefilled at connect.',
        doneLabel: 'I’ve added the groups parameter',
      },
      {
        id: 'assign-users',
        title: 'Assign users to the app',
        where: 'idp',
        menuPath: 'OneLogin admin → Users',
        intro:
          'A OneLogin user can only sign into an app that is assigned to them — an unassigned user is rejected at sign-in ("app not available"). Assign your test user before testing.',
        content: [
          {
            kind: 'text',
            text: 'For a single tester: Users → open the test user → Applications tab → "+" → add "Kortix". For a team: Users → Roles → create or edit a Role that includes the Kortix app, then add members to that Role.',
          },
        ],
        note: 'When group sync maps OneLogin Roles, those same Roles are what gate app access — so assigning via a Role does double duty (access + the "groups" value).',
        doneLabel: 'I’ve assigned the test user to the app',
      },
      {
        id: 'metadata',
        title: 'Set identity provider metadata',
        kind: 'metadata-input',
        where: 'idp',
        menuPath: 'Your app → SSO → Issuer URL',
        intro:
          'On the SSO tab, copy the "Issuer URL" (it is a live, hosted metadata endpoint) and paste it below — keep the "Dynamic configuration" option selected. Prefer this over pasting XML: the hosted URL auto-refreshes if OneLogin rotates the signing certificate.',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/onelogin/metadata-1.png',
            alt: 'OneLogin SSO tab with the Issuer URL and the More Actions SAML Metadata download',
            schematic: {
              title: 'SSO',
              rows: [
                { label: 'Issuer URL', value: '(paste this — hosted metadata)', as: 'field' },
                { label: 'More Actions → SAML Metadata', value: 'XML fallback', as: 'button' },
              ],
            },
          },
        ],
        note: 'No hosted URL handy? Switch to "Manual configuration" and paste the XML from SSO → More Actions → SAML Metadata instead — it is the same metadata.',
        doneLabel: 'I’ve added the identity provider metadata',
      },
      importStep('groups'),
      testStep(),
    ],
  },
  {
    id: 'jumpcloud',
    name: 'JumpCloud',
    blurb: 'SAML via a JumpCloud SSO application',
    config: {
      groupClaimName: 'groups',
      groupValueHint:
        'JumpCloud sends only the groups BOUND to this application, on the "groups" attribute — bind (and map) the groups you want before they appear.',
      preferredMetadata: 'url',
      metadataSource:
        'The SSO app → Copy Metadata URL (a hosted link) — or Export Metadata for the same XML.',
      metadataUrlPlaceholder: 'https://sso.jumpcloud.com/saml2/<app-id>',
    },
    steps: [
      {
        id: 'create-app',
        title: 'Open the SSO application',
        where: 'idp',
        menuPath: 'JumpCloud admin → Access → SSO Applications',
        intro:
          'In the JumpCloud admin console: Access → SSO Applications → "+ Add New Application" → "Custom Application" (search "Custom SAML App") → "Configure SSO with SAML" → name it "Kortix". This opens the app’s SSO tab.',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/jumpcloud/create-app-1.png',
            alt: 'JumpCloud SSO applications list',
            schematic: {
              title: 'Access → SSO Applications',
              rows: [
                { label: '+ Add New Application', as: 'button' },
                { label: 'Custom Application', value: 'search "Custom SAML App"', as: 'field' },
              ],
            },
          },
        ],
        doneLabel: 'I’ve opened the SSO application',
      },
      {
        id: 'basic-saml',
        title: 'SSO configuration',
        where: 'idp',
        menuPath: 'Your app → SSO',
        intro: 'On the SSO tab, paste Kortix’s ACS URL and Entity ID into the two SP fields.',
        content: [
          {
            kind: 'sp-values',
            acsLabel: 'ACS URL',
            entityIdLabel: 'SP Entity ID',
            acsFirst: true,
          },
          {
            kind: 'image',
            src: '/sso-setup/jumpcloud/basic-saml-1.png',
            alt: 'JumpCloud SSO config with IdP Entity ID, SP Entity ID and ACS URL',
            schematic: {
              title: 'SSO configuration',
              rows: [
                { label: 'ACS URL', value: '(ACS URL below)', as: 'field' },
                { label: 'SP Entity ID', value: '(Entity ID below)', as: 'field' },
                { label: 'IdP Entity ID', value: 'leave as JumpCloud pre-filled it', as: 'field' },
              ],
            },
          },
          {
            kind: 'text',
            text: 'Paste the Kortix Entity ID into "SP Entity ID" ONLY. Leave "IdP Entity ID" as the value JumpCloud pre-populates — that is JumpCloud’s own identifier and it flows into the exported metadata for you. Then check "Sign Assertion".',
          },
        ],
        doneLabel: 'I’ve entered the SSO configuration',
      },
      {
        id: 'attributes',
        title: 'User attribute mapping',
        where: 'idp',
        menuPath: 'Your app → SSO → User Attributes',
        intro:
          'Under "User Attributes", add each Service-Provider-Attribute-Name → JumpCloud-Attribute-Name pair. The left column is the SAML claim Kortix receives; the right is the JumpCloud user field.',
        content: [
          {
            kind: 'claims-table',
            rows: [
              { name: 'email', source: 'email', required: true },
              { name: 'id', source: 'email', required: true },
              { name: 'firstName', source: 'firstname' },
              { name: 'lastName', source: 'lastname' },
            ],
          },
          {
            kind: 'image',
            src: '/sso-setup/jumpcloud/attributes-1.png',
            alt: 'JumpCloud User Attributes mapping',
            schematic: {
              title: 'User Attributes',
              rows: [
                { label: 'email', value: '→ email', as: 'field' },
                { label: 'id', value: '→ email', as: 'field' },
                { label: 'firstName', value: '→ firstname', as: 'field' },
                { label: 'lastName', value: '→ lastname', as: 'field' },
              ],
            },
          },
        ],
        doneLabel: 'I’ve mapped the user attributes',
      },
      {
        id: 'group-claim',
        title: 'Enable the group attribute',
        where: 'idp',
        menuPath: 'Your app → SSO → Group Attributes',
        intro:
          'Under "Group Attributes", check "include group attribute" and set the attribute name to "groups".',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/jumpcloud/group-claim-1.png',
            alt: 'JumpCloud include group attribute set to groups',
            schematic: {
              title: 'Group Attributes',
              rows: [
                { label: 'include group attribute', value: 'checked', as: 'field' },
                { label: 'attribute name', value: 'groups', as: 'field' },
              ],
            },
          },
        ],
        note: 'JumpCloud only sends groups the application is BOUND to (User Groups tab). Bind each group you plan to map in Kortix; the name must match the connect-step claim.',
        doneLabel: 'I’ve enabled the group attribute',
      },
      {
        id: 'assign-users',
        title: 'Bind a user group for access',
        where: 'idp',
        menuPath: 'Your app → User Groups',
        intro:
          'In JumpCloud a user can only reach an SSO app if a user GROUP they belong to is bound on the app’s "User Groups" tab — there is no per-user assignment. Bind a group before testing, or the sign-in is rejected as "not assigned".',
        content: [
          {
            kind: 'text',
            text: 'Open the app → "User Groups" tab → tick the group(s) whose members may sign in (create one under User Groups and add your test user first if you have none). Save.',
          },
        ],
        note: 'Binding here does double duty: it grants sign-in access AND selects which groups get sent in the "groups" claim you enabled above.',
        doneLabel: 'I’ve bound a user group to the app',
      },
      {
        id: 'metadata',
        title: 'Set identity provider metadata',
        kind: 'metadata-input',
        where: 'idp',
        menuPath: 'Your app → SSO → Copy Metadata URL',
        intro:
          'Tick "Declare Redirect Endpoint" FIRST (it changes the generated metadata), then click "Activate" / "Save" — that step generates the app’s signing certificate. Only AFTER saving, copy the "Metadata URL" and paste it below (keep "Dynamic configuration" selected).',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/jumpcloud/metadata-1.png',
            alt: 'JumpCloud Declare Redirect Endpoint, Save, and Copy Metadata URL',
            schematic: {
              title: 'SSO configuration',
              rows: [
                { label: 'Declare Redirect Endpoint', value: 'check FIRST', as: 'field' },
                { label: 'Activate / Save', value: 'generates the signing cert', as: 'button' },
                { label: 'Copy Metadata URL', value: '(paste this)', as: 'button' },
              ],
            },
          },
        ],
        warning:
          'Order matters: tick "Declare Redirect Endpoint" and Save BEFORE copying metadata — copying before Save yields metadata with the wrong binding or a missing certificate, and Kortix silently gets the wrong SSO endpoint.',
        note: 'No hosted URL? Switch to "Manual configuration" and paste the XML from "Export Metadata" instead — but the URL auto-refreshes when JumpCloud rotates the cert, so prefer it.',
        doneLabel: 'I’ve added the identity provider metadata',
      },
      importStep('groups'),
      testStep(),
    ],
  },
  {
    id: 'pingone',
    name: 'PingOne',
    blurb: 'SAML via a PingOne application',
    config: {
      groupClaimName: 'groups',
      groupValueHint:
        'PingOne sends group NAMES when you map a "groups" attribute to "Group Names" — groups are OFF by default, add the mapping explicitly.',
      preferredMetadata: 'url',
      metadataSource: 'The app’s Configuration tab → IdP Metadata URL (a hosted link).',
      metadataUrlPlaceholder: 'https://auth.pingone.com/<env-id>/saml20/metadata/<app-id>',
    },
    steps: [
      {
        id: 'create-app',
        title: 'Open your SAML application',
        where: 'idp',
        menuPath: 'PingOne → Connections → Applications',
        intro:
          'In the PingOne admin console: Connections → Applications → open the app for Kortix, or click "+" to add one: enter the name "Kortix", choose the "SAML Application" type (not OIDC/SPA/Worker/Native), then Configure.',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/pingone/create-app-1.png',
            alt: 'PingOne Applications list',
            schematic: {
              title: 'Connections → Applications → +',
              rows: [
                { label: 'Application name', value: 'Kortix', as: 'field' },
                { label: 'Application type', value: 'SAML Application', as: 'field' },
              ],
            },
          },
        ],
        doneLabel: 'I’ve opened the SAML application',
      },
      {
        id: 'basic-saml',
        title: 'Import the SP metadata',
        where: 'idp',
        menuPath: 'Your app → Configuration → SAML',
        intro:
          'PingOne derives the ACS URL and Entity ID from Kortix’s SP metadata — you don’t type them separately. On the app’s SAML Configuration page, choose "Import from URL" (NOT the default "Manually Enter"), paste Kortix’s Identifier (Entity ID) into the metadata URL field, and click Import — PingOne auto-fills the ACS URLs and Entity ID.',
        content: [
          {
            kind: 'sp-values',
            entityIdLabel: 'Import from URL → metadata URL (paste this)',
            acsLabel: 'ACS URLs — imported for you',
          },
          {
            kind: 'image',
            src: '/sso-setup/pingone/basic-saml-1.png',
            alt: 'PingOne SAML Configuration with the Import from URL option',
            schematic: {
              title: 'Configuration → SAML',
              rows: [
                { label: 'Provide App Metadata', value: 'Import from URL', as: 'field' },
                { label: 'Metadata URL', value: '(the Entity ID below)', as: 'field' },
                { label: 'Import', as: 'button' },
              ],
            },
          },
        ],
        note: 'Kortix’s Entity ID IS the SP metadata endpoint, so importing it fills ACS + Audience for you. Pick "Manually Enter" instead and there is no "SP Metadata URL" field — you’d have to type the ACS URL and Entity ID by hand.',
        doneLabel: 'I’ve imported the SP metadata',
      },
      {
        id: 'attributes',
        title: 'Attribute mapping',
        where: 'idp',
        menuPath: 'Your app → Attribute Mapping',
        intro:
          'In "Attribute Mapping", first set the SAML Subject (the "saml_subject" row / Name ID) to "Email Address" — it defaults to "User ID" (a GUID), but Kortix correlates accounts by email. Then add these outgoing SAML attributes (Kortix name → PingOne source):',
        content: [
          {
            kind: 'claims-table',
            rows: [
              { name: 'email', source: 'Email Address', required: true },
              { name: 'id', source: 'User ID', required: true },
              { name: 'firstName', source: 'Given Name' },
              { name: 'lastName', source: 'Family Name' },
            ],
          },
          {
            kind: 'image',
            src: '/sso-setup/pingone/attributes-1.png',
            alt: 'PingOne Attribute Mapping with saml_subject, email, id, firstName, lastName',
            schematic: {
              title: 'Attribute Mapping',
              rows: [
                { label: 'saml_subject (Name ID)', value: 'Email Address', as: 'field' },
                { label: 'email', value: 'Email Address', as: 'field' },
                { label: 'id', value: 'User ID', as: 'field' },
                { label: 'firstName', value: 'Given Name', as: 'field' },
                { label: 'lastName', value: 'Family Name', as: 'field' },
              ],
            },
          },
        ],
        note: 'The saml_subject / Name ID defaults to a GUID — set it to Email Address (format urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress) so the subject matches the email Kortix keys on, belt-and-braces with the email attribute.',
        doneLabel: 'I’ve mapped the attributes',
      },
      {
        id: 'group-claim',
        title: 'Add the groups attribute',
        where: 'idp',
        menuPath: 'Your app → Attribute Mapping',
        intro:
          'Still in Attribute Mapping, add a "groups" attribute mapped to PingOne’s "Group Names" — this sends the names of the user’s groups.',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/pingone/group-claim-1.png',
            alt: 'PingOne groups attribute mapped to Group Names',
            schematic: {
              title: 'Attribute Mapping → groups',
              rows: [{ label: 'groups', value: 'Group Names', as: 'field' }],
            },
          },
        ],
        note: 'Groups are off by default — without this mapping PingOne sends none. The attribute name (groups) must match the connect-step claim.',
        doneLabel: 'I’ve added the groups attribute',
      },
      {
        id: 'metadata',
        title: 'Set identity provider metadata',
        kind: 'metadata-input',
        where: 'idp',
        menuPath: 'Your app → Configuration → IdP Metadata URL',
        intro:
          'On the Configuration tab, ENABLE the application, then copy the "IdP Metadata URL" and paste it below.',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/pingone/metadata-1.png',
            alt: 'PingOne Configuration tab with the IdP Metadata URL',
            schematic: {
              title: 'Configuration',
              rows: [
                { label: 'Enable application', value: 'on', as: 'field' },
                { label: 'IdP Metadata URL', value: '(paste this)', as: 'field' },
              ],
            },
          },
        ],
        note: 'Enable the app first — a disabled PingOne app rejects sign-ins even with correct metadata.',
        doneLabel: 'I’ve added the identity provider metadata',
      },
      importStep('groups'),
      testStep(),
    ],
  },
  {
    id: 'auth0',
    name: 'Auth0',
    blurb: 'SAML via the Auth0 SAML2 Web App addon',
    config: {
      groupClaimName: 'groups',
      groupValueHint:
        'Auth0’s SAML2 Web App addon does NOT send groups by default — you add a groups claim with an Auth0 Action/Rule. Until then, only email + name arrive.',
      preferredMetadata: 'url',
      metadataSource:
        'The application’s Settings → Advanced Settings → Endpoints → SAML Metadata URL (hosted).',
      metadataUrlPlaceholder: 'https://<your-tenant>.auth0.com/samlp/metadata/<client-id>',
    },
    steps: [
      {
        id: 'create-app',
        title: 'Open your application',
        where: 'idp',
        menuPath: 'Auth0 Dashboard → Applications → Applications',
        intro:
          'In the Auth0 dashboard: Applications → Applications → open (or create) the application for Kortix. Creating a new one? Choose "Regular Web Application" — the SAML2 addon works regardless of type, but this avoids second-guessing the picker.',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/auth0/create-app-1.png',
            alt: 'Auth0 Applications list',
            schematic: {
              title: 'Applications → Applications',
              rows: [{ label: 'Your application', as: 'field' }],
            },
          },
        ],
        doneLabel: 'I’ve opened the application',
      },
      {
        id: 'addon',
        title: 'Enable the SAML2 Web App addon',
        where: 'idp',
        menuPath: 'Your app → Addons',
        intro:
          'Open the app’s "Addons" tab — it sits in the tab strip at the top of the application page (Quickstart · Settings · Credentials · APIs · Organizations · Addons · Connections), NOT inside the Settings page — and toggle ON "SAML2 Web App". This opens the addon’s Settings modal.',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/auth0/addon-1.png',
            alt: 'Auth0 Addons tab with the SAML2 Web App toggle',
            schematic: {
              title: 'Application → Addons',
              rows: [{ label: 'SAML2 Web App', value: 'toggle ON', as: 'field' }],
            },
          },
        ],
        doneLabel: 'I’ve enabled the SAML2 Web App addon',
      },
      {
        id: 'basic-saml',
        title: 'Callback URL and audience',
        where: 'idp',
        menuPath: 'SAML2 Web App → Settings',
        intro:
          'In the addon’s Settings modal, paste Kortix’s ACS URL into "Application Callback URL". The Entity ID is NOT a form field — it goes inside the JSON.',
        content: [
          {
            kind: 'sp-values',
            acsLabel: 'Application Callback URL (ACS)',
            entityIdLabel: 'audience (put in the Settings JSON)',
            acsFirst: true,
          },
          {
            kind: 'image',
            src: '/sso-setup/auth0/basic-saml-1.png',
            alt: 'Auth0 SAML2 Web App Application Callback URL field',
            schematic: {
              title: 'SAML2 Web App → Settings',
              rows: [{ label: 'Application Callback URL', value: '(ACS URL below)', as: 'field' }],
            },
          },
          {
            kind: 'text',
            text: 'In the "Settings" JSON object below the callback field, set TWO things: (1) "audience" = Kortix’s Entity ID, and (2) force the NameID to the user’s email — it defaults to the opaque Auth0 user_id (auth0|…), which Kortix can’t correlate. Add: "audience": "…/saml/metadata", "nameIdentifierFormat": "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress", "nameIdentifierProbes": ["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"]. Then scroll down and click "Enable".',
          },
          {
            kind: 'image',
            src: '/sso-setup/auth0/audience-1.png',
            alt: 'Auth0 SAML2 Web App Settings JSON with the audience and NameID values',
            schematic: {
              title: 'Settings JSON',
              rows: [
                { label: '"audience"', value: 'the Entity ID below', as: 'field' },
                {
                  label: '"nameIdentifierFormat"',
                  value: '…nameid-format:emailAddress',
                  as: 'field',
                },
              ],
            },
          },
        ],
        warning:
          '#1 Auth0 gotcha: two easy-to-miss values live inside the Settings JSON, not labeled fields — the audience (Entity ID) AND the NameID format. The addon defaults NameID to the Auth0 user_id (auth0|…), so without the emailAddress nameIdentifierFormat above, Kortix correlates on the wrong subject and every sign-in mis-identifies or fails.',
        doneLabel: 'I’ve set the callback URL, audience, and NameID',
      },
      {
        id: 'metadata',
        title: 'Set identity provider metadata',
        kind: 'metadata-input',
        where: 'idp',
        menuPath: 'Your app → Settings → Advanced Settings → Endpoints',
        intro:
          'Back on the application’s Settings page, expand "Advanced Settings" → "Endpoints" tab, and copy the "SAML Metadata URL". Paste it below.',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/auth0/metadata-1.png',
            alt: 'Auth0 Advanced Settings Endpoints tab with the SAML Metadata URL',
            schematic: {
              title: 'Advanced Settings → Endpoints',
              rows: [{ label: 'SAML Metadata URL', value: '(paste this)', as: 'field' }],
            },
          },
        ],
        note: 'Groups: the default SAML2 Web App addon sends only email + name. To sync groups, add an Auth0 Action/Rule that emits a claim NAMED exactly "groups" (matching the connect-step claim). Auth0’s built-in group attribute URI "http://schemas.xmlsoap.org/claims/Group" will NOT match — map it to "groups". Then map those names in Kortix.',
        doneLabel: 'I’ve added the identity provider metadata',
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
        title: 'Set identity provider metadata',
        kind: 'metadata-input',
        intro:
          'Export your IdP’s SAML metadata — paste its metadata URL, or switch to Manual and paste the raw XML. It carries into the connect step automatically.',
        doneLabel: 'I’ve added the identity provider metadata',
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

/**
 * Mint-and-connect on ONE page: the mint action, the copyable Tenant URL +
 * secret, AND the "now paste these into your IdP" instructions all live in a
 * single step (the wizard renders `content` inside the mint step, right below
 * the freshly minted values). Callers pass the IdP-side paste steps as
 * `content`; kind/id are forced so every SCIM guide shares one shape.
 */
const scimConnectStep = (step: {
  content: StepBlock[];
  title?: string;
  intro?: string;
  where?: 'kortix' | 'idp';
  menuPath?: string;
  success?: string;
  warning?: string;
  note?: string;
  doneLabel?: string;
}): GuideStep => ({
  where: 'idp',
  title: 'Mint a token & connect provisioning',
  intro:
    'Mint the bearer token your identity provider authenticates with — then paste it and the Tenant URL straight into your IdP below. Everything you need stays on this one page; no flipping back to copy a value.',
  ...step,
  id: 'connect',
  kind: 'scim-token',
});

const scimTestStep = (
  opts: { extra?: string; content?: StepBlock[]; success?: string } = {},
): GuideStep => ({
  id: 'test',
  title: 'Verify provisioning',
  kind: 'test',
  where: 'idp',
  intro:
    'Back in Kortix, watch the live status below while you push or wait for the sync — no need to tab back and forth to check.',
  ...(opts.content ? { content: opts.content } : {}),
  bullets: [
    'A pushed user appears under Members (as a pending invite until their first sign-in).',
    'Deactivating the user in the IdP removes their membership and revokes their tokens.',
    'Pushed groups appear under Groups — grant them project roles to confer access.',
    'Group membership for a user who hasn’t signed in yet is held on their invite and applies automatically at their FIRST sign-in — an empty group before that is expected, not a failure.',
    ...(opts.extra ? [opts.extra] : []),
  ],
  success:
    opts.success ??
    'The member/group counts below tick up, and your IdP’s provisioning log shows the sync succeeded.',
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
      syncCadenceHint:
        'Entra runs its scheduled provisioning cycle roughly every 40 minutes — changes apply on the next cycle, or instantly with "Provision on demand".',
      startSyncHint:
        'Provisioning → "Start provisioning" (Provisioning Status: On). The scheduled cycle then runs every ~40 minutes on its own; "Provision on demand" pushes one user instantly.',
    },
    steps: [
      {
        id: 'before',
        title: 'Before you start',
        where: 'idp',
        intro:
          'Directory Sync pushes users and groups from Entra proactively — deactivations apply without waiting for a sign-in. It reuses the same enterprise application you already registered for SAML SSO; nothing new to create.',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/entra/scim-before-1.png',
            alt: 'Entra enterprise application overview page with the Single sign-on, Provisioning, and Users and groups tabs in the left nav',
            schematic: {
              title: 'Enterprise application → Overview',
              rows: [
                { label: 'Single sign-on', as: 'badge' },
                { label: 'Provisioning', as: 'badge' },
                { label: 'Users and groups', as: 'badge' },
              ],
            },
          },
        ],
        bullets: [
          'Open the same enterprise application you created for SAML SSO (Entra ID → Enterprise applications → your app).',
          'Automatic provisioning requires Entra ID P1/P2 (a trial works fine).',
          'Connect SAML SSO first — Directory Sync can create and remove accounts, but users still need SSO to sign in.',
        ],
      },
      scimConnectStep({
        title: 'Mint a token & connect provisioning in Entra',
        where: 'idp',
        menuPath: 'Enterprise applications → your app → Provisioning',
        intro:
          'Four things, in order: paste credentials, check the one mapping, assign users, then start. Both values you need are shown above.',
        content: [
          {
            kind: 'text',
            text: 'Open "Provisioning" in the left nav and click "Get started" (first time) or "Edit provisioning" (if already configured). Set "Provisioning Mode" to "Automatic".',
          },
          {
            kind: 'image',
            src: '/sso-setup/entra/scim-credentials-1.png',
            alt: 'Entra Provisioning Admin Credentials section with Tenant URL, Secret Token, and Test Connection',
            schematic: {
              title: 'Entra → Provisioning → Admin Credentials',
              rows: [
                { label: 'Tenant URL', value: '(shown above)', as: 'field' },
                { label: 'Secret Token', value: '(shown above)', as: 'field' },
                { label: 'Test Connection', as: 'button' },
              ],
            },
          },
          {
            kind: 'text',
            text: 'Under "Admin Credentials", paste the two values shown above: "Tenant URL" and "Secret Token". Click "Test Connection" — a green "Testing the connection was successful" banner is success. Click "Save".',
          },
          {
            kind: 'text',
            text: 'Expand "Mappings" → "Provision Microsoft Entra ID Users". The one row that matters: "userName" must map to source attribute "user.userprincipalname" — that is how Kortix matches the SCIM user to a Kortix account. Leave the default "objectId → externalId" mapping as-is (that\'s how Entra recognizes a record it already pushed on later syncs) and leave the rest at their defaults.',
          },
          {
            kind: 'image',
            src: '/sso-setup/entra/scim-mappings-1.png',
            alt: 'Entra provisioning attribute mappings list with the userName to user.userprincipalname row highlighted',
            schematic: {
              title: 'Provisioning → Mappings → Provision Microsoft Entra ID Users',
              rows: [
                { label: 'userName', value: 'user.userprincipalname', as: 'field' },
                { label: 'objectId', value: 'externalId', as: 'field' },
              ],
            },
          },
          {
            kind: 'text',
            text: 'Assignment is the allow-list: only users/groups assigned to this application get provisioned. In the left nav click "Users and groups" → "+ Add user/group" → click "None Selected" under Users → pick a user (recommended: assign yourself first so you can watch yourself arrive) → "Select" → "Assign".',
          },
          {
            kind: 'image',
            src: '/sso-setup/entra/scim-assign-1.png',
            alt: 'Entra Users and groups panel with Add user/group open and a user selected for assignment',
            schematic: {
              title: 'Manage → Users and groups',
              rows: [
                { label: '+ Add user/group', as: 'button' },
                { label: 'Users', value: 'None Selected', as: 'field' },
                { label: 'Assign', as: 'button' },
              ],
            },
          },
          {
            kind: 'text',
            text: 'Back in "Provisioning" → "Settings", set "Scope" to "Sync only assigned users and groups" — it only appears here after credentials are saved. Then click "Start provisioning" at the top of the Provisioning overview page (or "Provision on demand" to push one assigned user instantly instead of waiting for the ~40-minute cycle).',
          },
          {
            kind: 'text',
            text: '"Sync only assigned users and groups" makes this app\'s Users and groups list your allowlist: roll out team-by-team, and unassigning someone removes their Kortix access. "Sync all users and groups" gives every person in your Entra tenant a Kortix account — fine for a small or dedicated tenant, rarely what a company tenant wants on day one.',
          },
          {
            kind: 'image',
            src: '/sso-setup/entra/scim-start-1.png',
            alt: 'Entra Provisioning overview page toolbar with Start provisioning and Provision on demand buttons',
            schematic: {
              title: 'Provisioning → Overview',
              rows: [
                { label: 'Provisioning Status', value: 'On', as: 'field' },
                { label: 'Scope', value: 'Sync only assigned users and groups', as: 'field' },
                { label: 'Start provisioning', as: 'button' },
                { label: 'Provision on demand', as: 'button' },
              ],
            },
          },
        ],
        success:
          'Test Connection passes, the Mappings list shows userName → user.userprincipalname, at least one user/group is assigned, and the Provisioning overview shows "On".',
        warning:
          '#1 failure mode: Test Connection fails. Almost always a hand-typed or truncated Tenant URL — re-copy it exactly from above (it is not the regular Kortix API URL and has no /v1 suffix). Assigning a whole GROUP (rather than individual users) needs Entra ID P1/P2; on Free, assign users one at a time.',
        doneLabel: 'I’ve configured, mapped, assigned, and started provisioning',
      }),
      scimTestStep({
        success:
          'The member/group counts below tick up, and in Entra’s Provisioning log every stage (Import, Scope, Match, Perform action) shows Success.',
        extra:
          'To deactivate from Entra: set the user’s "Block sign in" (Account enabled = off), then provision them again — or run "Provision on demand" to apply it immediately.',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/entra/scim-verify-1.png',
            alt: 'Entra Provisioning overview showing a completed cycle with Import, Scope, Match, and Provision all reporting Success',
            schematic: {
              title: 'Provisioning → Overview → Current cycle',
              rows: [
                { label: 'Import', value: 'Success', as: 'badge' },
                { label: 'Scope', value: 'Success', as: 'badge' },
                { label: 'Match', value: 'Success', as: 'badge' },
                { label: 'Provision', value: 'Success', as: 'badge' },
              ],
            },
          },
        ],
      }),
    ],
  },
  {
    id: 'okta',
    name: 'Okta',
    blurb: 'Automatic provisioning from Okta',
    config: {
      groupClaimName: 'groups',
      groupValueHint: 'Groups pushed via Push Groups are created in Kortix under their Okta names.',
      syncCadenceHint:
        'Okta pushes changes as they happen (assignments, profile updates, group pushes) — a quiet period just means nothing changed.',
      startSyncHint:
        'Provisioning → "To App" → Edit → enable Create / Update / Deactivate Users → Save. Assignments and pushed groups then sync automatically as they change.',
    },
    steps: [
      {
        id: 'before',
        title: 'Before you start',
        intro: 'Use the same Okta app integration you created for SAML SSO.',
        bullets: ['Connect SAML SSO first so provisioned users can sign in.'],
      },
      scimConnectStep({
        title: 'Mint a token & enable SCIM on the Okta app',
        where: 'idp',
        menuPath: 'Your app → General → App Settings',
        intro: 'In the Okta admin console, open the app → General → App Settings → Edit.',
        content: [
          {
            kind: 'text',
            text: 'On the app’s "Provisioning" tab, choose SCIM and Save. A configuration panel appears → "Configure API Integration" → tick "Enable API integration".',
          },
          {
            kind: 'image',
            src: '/sso-setup/okta/scim-credentials-1.png',
            alt: 'Okta app Provisioning tab with the Configure API Integration panel',
            schematic: {
              title: 'App → Provisioning → Configure API Integration',
              rows: [
                { label: 'Enable API integration', as: 'field' },
                {
                  label: 'SCIM connector base URL',
                  value: '(the Tenant URL shown above)',
                  as: 'field',
                },
                { label: 'Unique identifier field for users', value: 'userName', as: 'field' },
                { label: 'Authentication Mode', value: 'HTTP Header', as: 'field' },
                { label: 'API Token', value: '(the secret shown above)', as: 'field' },
                { label: 'Test API Credentials', as: 'button' },
              ],
            },
          },
          {
            kind: 'text',
            text: 'Fill it from the values above: "SCIM connector base URL" = the Tenant URL; "Unique identifier field for users" = userName; "Authentication Mode" = HTTP Header, and paste the secret as the API Token. Click "Test API Credentials", then "Save".',
          },
        ],
        doneLabel: 'I’ve enabled and connected SCIM',
      }),
      {
        id: 'to-app',
        title: 'Turn on the sync actions',
        where: 'idp',
        menuPath: 'Your app → Provisioning → To App',
        intro: 'On the Provisioning tab → To App → Edit.',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/okta/scim-to-app-1.png',
            alt: 'Provisioning To App settings with the three sync-action checkboxes',
            schematic: {
              title: 'Provisioning → To App',
              rows: [
                { label: 'Create Users', as: 'field' },
                { label: 'Update User Attributes', as: 'field' },
                { label: 'Deactivate Users', as: 'field' },
                { label: 'Save', as: 'button' },
              ],
            },
          },
        ],
        bullets: ['Enable Create Users, Update User Attributes, and Deactivate Users → Save.'],
        doneLabel: 'I’ve turned on the sync actions',
      },
      {
        id: 'assign',
        title: 'Assign people and push groups',
        where: 'idp',
        menuPath: 'Your app → Assignments / Push Groups',
        intro:
          'Assignments is the allow-list: only assigned people/groups get provisioned. Push Groups is separate — it syncs group membership for groups you explicitly push.',
        content: [
          {
            kind: 'text',
            text: 'Assignments tab → "Assign" → "Assign to People" (or "Assign to Groups") → pick who should be provisioned → "Done".',
          },
          {
            kind: 'text',
            text: 'Push Groups tab → "+ Push Groups" → "Find groups by name" → search and select the group → check "Push Immediately" → "Save".',
          },
          {
            kind: 'image',
            src: '/sso-setup/okta/scim-push-groups-1.png',
            alt: 'Push Groups tab with Find groups by name and Push Immediately option',
            schematic: {
              title: 'Push Groups',
              rows: [
                { label: 'Find groups by name', value: 'Engineers', as: 'field' },
                { label: 'Push Immediately', as: 'field' },
                { label: 'Save', as: 'button' },
              ],
            },
          },
          {
            kind: 'text',
            text: '"Assign to People/Groups" makes the Assignments tab your allowlist: roll out team-by-team, and unassigning someone removes their Kortix access. There is no "sync everyone" toggle in Okta the way Entra has one — Assignments IS the scope, always.',
          },
        ],
        doneLabel: 'I’ve assigned people and pushed groups',
      },
      scimTestStep(),
    ],
  },
  {
    id: 'onelogin',
    name: 'OneLogin',
    blurb: 'Automatic provisioning from OneLogin',
    config: {
      groupClaimName: 'groups',
      groupValueHint:
        'Groups pushed from OneLogin Rules are created in Kortix under their OneLogin names.',
      syncCadenceHint:
        'OneLogin pushes changes as they happen once provisioning is enabled — a quiet period just means nothing changed (or actions are held in the approval queue).',
      startSyncHint:
        'Provisioning tab → tick "Enable provisioning" and UNCHECK "Require admin approval" for Create/Update/Delete — otherwise every change waits in the pending queue.',
    },
    steps: [
      {
        id: 'before',
        title: 'Before you start',
        where: 'idp',
        intro:
          'OneLogin pushes users and groups to Kortix with its "SCIM Provisioner with SAML" connector — a SEPARATE app from the SAML-only connector. Outbound provisioning is a paid OneLogin tier; the Provisioning tab only appears when your plan includes it.',
        bullets: [
          'Connect SAML SSO first — provisioning creates accounts, but users still need SSO to sign in.',
          'You will add a new SCIM connector app below; the SAML Custom Connector used for SSO does not push users.',
        ],
      },
      scimConnectStep({
        title: 'Mint a token & connect the SCIM connector',
        where: 'idp',
        menuPath: 'OneLogin admin → Applications → Add App',
        intro: 'Add a OneLogin SCIM connector and point it at the two values shown above.',
        content: [
          {
            kind: 'text',
            text: 'Applications → Applications → "Add App" → search "SCIM" → pick "SCIM Provisioner with SAML (SCIM v2 Core)" → name it "Kortix" → Save. Then open the app’s "Configuration" tab.',
          },
          {
            kind: 'schematic',
            schematic: {
              title: 'Configuration → API Connection',
              rows: [
                { label: 'SCIM Base URL', value: '(the Tenant URL above)', as: 'field' },
                { label: 'SCIM Bearer Token', value: '(the secret above)', as: 'field' },
                { label: 'Enable', as: 'button' },
                { label: 'API Status', value: 'Enabled (read-only)', as: 'badge' },
              ],
            },
          },
          {
            kind: 'text',
            text: 'Under "API Connection": paste the Tenant URL into "SCIM Base URL" and the secret into "SCIM Bearer Token", then click the "Enable" button (save the app first if prompted). OneLogin validates the endpoint and "API Status" then shows a green "Enabled" — that field is a read-only indicator, not a control you set.',
          },
          {
            kind: 'text',
            text: 'On the "Parameters" tab, set the "SCIM Username" parameter’s value to the user’s Email — that makes SCIM userName the email Kortix correlates on. Leave the default externalId mapping as-is.',
          },
          {
            kind: 'text',
            text: 'On the "Provisioning" tab, tick "Enable provisioning". Then UNCHECK "Require admin approval before this action is performed" for Create, Update, and Delete — otherwise every change waits in a pending queue and nothing reaches Kortix until you approve it by hand.',
          },
          {
            kind: 'schematic',
            schematic: {
              title: 'Provisioning → Workflow',
              rows: [
                { label: 'Enable provisioning', value: 'checked', as: 'field' },
                { label: 'Require admin approval — Create', value: 'unchecked', as: 'field' },
                {
                  label: 'Require admin approval — Update / Delete',
                  value: 'unchecked',
                  as: 'field',
                },
              ],
            },
          },
        ],
        success:
          'API Status shows a green "Enabled", the "SCIM Username" parameter maps to Email, and provisioning is enabled without the admin-approval hold.',
        warning:
          '#1 OneLogin gotcha: users seem to sync but nothing lands in Kortix — the actions are stuck in the Provisioning "pending" queue because "Require admin approval" is still checked. Uncheck it for Create/Update/Delete (or approve the queue).',
        doneLabel: 'I’ve connected and enabled provisioning',
      }),
      {
        id: 'assign',
        title: 'Assign users and push groups',
        where: 'idp',
        menuPath: 'Your app → Users / Rules',
        intro:
          'A user is provisioned only once this SCIM app is assigned to them; group membership is pushed with a Rule.',
        content: [
          {
            kind: 'text',
            text: 'Assign the app: Users → open a user → "Applications" → "+" → add "Kortix" (or assign the app to a Role so everyone in that Role is provisioned).',
          },
          {
            kind: 'text',
            text: 'Push groups: on the app’s "Provisioning" tab, under "Entitlements", click "Refresh" so Kortix’s groups load. Then on the "Rules" tab add a Rule — a condition (e.g. member of a OneLogin Role) with the action "Set Groups in Kortix" → the group.',
          },
          {
            kind: 'text',
            text: 'After saving the rule, click "Reapply entitlement mappings" (app → Users → More Actions) to push groups to users who are ALREADY assigned — otherwise existing members’ groups only sync on their next change.',
          },
        ],
        note: 'Only assigned users are provisioned; users created directly in Kortix are not linked back to OneLogin.',
        doneLabel: 'I’ve assigned users and pushed groups',
      },
      scimTestStep({
        success:
          'The member/group counts below tick up, and OneLogin’s Provisioning log shows each user/group actioned (not left "pending").',
      }),
    ],
  },
  {
    id: 'jumpcloud',
    name: 'JumpCloud',
    blurb: 'Automatic provisioning from JumpCloud',
    config: {
      groupClaimName: 'groups',
      groupValueHint:
        'The JumpCloud user groups you bind to the app are created in Kortix under their JumpCloud names.',
      syncCadenceHint:
        'JumpCloud pushes changes as they happen (group binds, membership changes) — a quiet period just means nothing changed.',
      startSyncHint:
        'Identity Management → "Test Connection" → "Activate", then bind user groups on the "User Groups" tab — bound groups and their members push automatically.',
    },
    steps: [
      {
        id: 'before',
        title: 'Before you start',
        where: 'idp',
        intro:
          'JumpCloud pushes users and groups to Kortix from a "Custom Application" using its Identity Management (SCIM) tab. Provisioning needs the JumpCloud SSO entitlement.',
        bullets: [
          'Connect SAML SSO first so provisioned users can sign in.',
          'You can reuse the same Custom Application you made for SAML SSO — SCIM lives on its "Identity Management" tab.',
        ],
      },
      scimConnectStep({
        title: 'Mint a token & connect Identity Management',
        where: 'idp',
        menuPath: 'JumpCloud admin → Access → SSO Applications → your app → Identity Management',
        intro:
          'On the app’s "Identity Management" tab, turn on SCIM and point it at the two values shown above.',
        content: [
          {
            kind: 'text',
            text: 'Open the app → "Identity Management" tab. In its Configuration set "API Type" = "SCIM API" and "SCIM Version" = "SCIM 2.0".',
          },
          {
            kind: 'schematic',
            schematic: {
              title: 'Identity Management → Configuration',
              rows: [
                { label: 'API Type', value: 'SCIM API', as: 'field' },
                { label: 'SCIM Version', value: 'SCIM 2.0', as: 'field' },
                { label: 'Base URL', value: '(the Tenant URL above)', as: 'field' },
                { label: 'Token Key', value: '(the secret above)', as: 'field' },
                { label: 'Test Connection', as: 'button' },
                { label: 'Activate', as: 'button' },
              ],
            },
          },
          {
            kind: 'text',
            text: 'Paste the Tenant URL into "Base URL" and the secret into "Token Key" (auth is HTTP Header → Authorization: Bearer). Enter a FRESH test-user email that does NOT already exist in Kortix, click "Test Connection", then click "Activate" — do NOT click Save during the test-user step or you lose the configuration.',
          },
          {
            kind: 'text',
            text: 'Under "Export Attribute Mapping", confirm the user’s email flows into SCIM "userName" — JumpCloud sets this by default, so there’s usually nothing to change. Kortix correlates on that email.',
          },
        ],
        success:
          'Test Connection passes with a fresh test email, and the app’s Identity Management shows Activated.',
        warning:
          '#1 JumpCloud gotcha: Test Connection fails because the test-user email already exists in Kortix — it must be a brand-new address. (And click "Activate", not "Save", during that step.)',
        doneLabel: 'I’ve connected and activated Identity Management',
      }),
      {
        id: 'assign',
        title: 'Bind groups to provision users',
        where: 'idp',
        menuPath: 'Your app → Identity Management (enable the checkbox) + User Groups tab',
        intro:
          'JumpCloud provisions the members of the user groups BOUND to this app — binding a group both scopes who is pushed and syncs the group itself.',
        content: [
          {
            kind: 'text',
            text: 'On the "Identity Management" tab itself (once Test Connection has succeeded), check "Enable management of User Groups and Group Membership in this application" so bound groups (and their members) are pushed to Kortix.',
          },
          {
            kind: 'text',
            text: 'On the app’s "User Groups" tab, tick the JumpCloud user group(s) whose members should be provisioned, then Save. Bind at least one group — with none bound, no users are pushed.',
          },
        ],
        note: 'Scope is group-based: membership of the bound groups defines who is provisioned. Unbinding a group deprovisions its members.',
        doneLabel: 'I’ve bound the groups to provision',
      },
      scimTestStep({
        success:
          'The member/group counts below tick up as JumpCloud pushes the bound groups and their members.',
      }),
    ],
  },
  {
    id: 'pingone',
    name: 'PingOne',
    blurb: 'Automatic provisioning from PingOne',
    config: {
      groupClaimName: 'groups',
      groupValueHint:
        'The internal PingOne groups you select on the provisioning rule are created in Kortix under their PingOne names.',
      syncCadenceHint:
        'PingOne runs an initial full sync when the rule goes Active, then pushes incremental changes as your directory changes.',
      startSyncHint:
        'Enable the CONNECTION toggle (top of its details panel, turns blue) AND set the provisioning rule to Active — both are required; a saved-but-disabled connection provisions nothing.',
    },
    steps: [
      {
        id: 'before',
        title: 'Before you start',
        where: 'idp',
        intro:
          'PingOne pushes users and groups to Kortix through a generic "SCIM Outbound" connection under Integrations → Provisioning. Use the modern PingOne cloud console (Workforce) — the legacy "PingOne for Enterprise" product does not have this.',
        bullets: [
          'Connect SAML SSO first so provisioned users can sign in.',
          'Your PingOne environment needs the Provisioning service enabled (standard on PingOne cloud, no separate SCIM SKU).',
        ],
      },
      scimConnectStep({
        title: 'Mint a token & create the SCIM Outbound connection',
        where: 'idp',
        menuPath: 'PingOne → Integrations → Provisioning → New Connection',
        intro:
          'Create a "SCIM Outbound" provisioning connection and point it at the two values shown above.',
        content: [
          {
            kind: 'text',
            text: 'Integrations → Provisioning → "+ New Connection" → on the "Identity Store" line click "Select" → choose the "SCIM Outbound" tile → "Select". Name it "Kortix", then "Configure Authentication".',
          },
          {
            kind: 'schematic',
            schematic: {
              title: 'SCIM Outbound → Configuration',
              rows: [
                { label: 'SCIM Base URL', value: '(the Tenant URL above)', as: 'field' },
                { label: 'Users Resource', value: '/Users', as: 'field' },
                { label: 'Groups Resource', value: '/Groups', as: 'field' },
                { label: 'SCIM Version', value: '2.0', as: 'field' },
                { label: 'Authentication Method', value: 'OAuth 2 Bearer Token', as: 'field' },
                { label: 'OAuth Access Token', value: '(the secret above)', as: 'field' },
                { label: 'Test connection', as: 'button' },
                { label: 'Enable connection (toggle)', value: 'on / blue', as: 'field' },
              ],
            },
          },
          {
            kind: 'text',
            text: 'Paste the Tenant URL into "SCIM Base URL", set "Users Resource" = /Users, "Groups Resource" = /Groups, "SCIM Version" = 2.0. Set "Authentication Method" = "OAuth 2 Bearer Token" and paste the secret into "OAuth Access Token". Click "Test connection", then Save.',
          },
          {
            kind: 'text',
            text: 'ENABLE the connection itself: click the toggle at the top of the connection’s details panel so it turns blue. A saved-but-disabled connection provisions NOTHING even with an Active rule — this is the easiest step to miss.',
          },
          {
            kind: 'text',
            text: 'Set userName to the email Kortix correlates on: open the "Attribute Mapping" section (separate from the auth screen), in the "PingOne Directory" column expand "Username" and select "Email Address". Then in the connection’s preferences/actions set "User Identifier" = userName and "User Filter Expression" = `userName eq "%s"`. Getting this wrong is the #1 PingOne failure — it defaults to the internal username, not the email.',
          },
        ],
        success:
          'Test connection passes, the connection toggle is enabled (blue), and the Username attribute maps to Email Address with a `userName eq "%s"` filter.',
        warning:
          '#1 PingOne gotcha: everything looks configured but zero users sync — the CONNECTION toggle is still off (it defaults off), or PingOne is sending its internal username instead of the email. Enable the connection toggle, map "Username" → "Email Address", and set the filter `userName eq "%s"`.',
        doneLabel: 'I’ve created, enabled, and tested the SCIM connection',
      }),
      {
        id: 'assign',
        title: 'Scope users and select groups',
        where: 'idp',
        menuPath: 'PingOne → Integrations → Provisioning → Rules',
        intro: 'A provisioning Rule decides which users and groups this connection pushes.',
        content: [
          {
            kind: 'text',
            text: 'Go to Integrations → Provisioning → "Rules" tab → open (or add) the rule for this connection → its "Directory" tab. Scope which people are provisioned with a User Filter ("Add Condition" on a population or user attribute) and/or by selecting Populations.',
          },
          {
            kind: 'text',
            text: 'Push groups: still in the rule’s "Directory" tab, click the pencil next to "Groups" → "Search Group Name" → pick the internal groups → review under "Selected Groups" → Save. PingOne pushes those groups and their memberships to /Groups.',
          },
          {
            kind: 'text',
            text: 'Set the rule to Active/enabled — PingOne then runs an initial full sync and incremental syncs on directory changes.',
          },
        ],
        note: 'Only internal PingOne groups can be pushed; membership scope follows the rule’s User Filter and Populations.',
        doneLabel: 'I’ve scoped users, selected groups, and activated the rule',
      },
      scimTestStep({
        success:
          'The member/group counts below tick up once the rule is Active and PingOne runs its first sync.',
      }),
    ],
  },
  {
    id: 'custom',
    name: 'Custom SCIM 2.0',
    blurb: 'Any SCIM 2.0-capable identity provider',
    config: {
      groupClaimName: 'groups',
      groupValueHint: 'Pushed groups are created in Kortix under their displayName.',
      syncCadenceHint:
        'Cadence depends on your IdP — most push changes as they happen; some run scheduled cycles. Check its provisioning log if nothing arrives.',
      startSyncHint:
        'Enable provisioning/sync in your IdP’s SCIM client and scope the users/groups to push — it then runs on the IdP’s own schedule.',
    },
    steps: [
      scimConnectStep({
        title: 'Mint a token & point your IdP at Kortix',
        content: [
          {
            kind: 'text',
            text: 'In your identity provider’s SCIM client, paste the two values shown above: "Base / Tenant URL" is the Tenant URL (the IdP appends /Users and /Groups), and the Bearer token is the secret.',
          },
          {
            kind: 'text',
            text: 'Set the matching attribute so "userName" is the user’s email — that is how Kortix correlates a SCIM user to an account.',
          },
        ],
        note: 'Kortix supports SCIM 2.0 Users + Groups, PATCH, and `attribute eq "value"` filters. Bulk operations are not supported.',
      }),
      scimTestStep(),
    ],
  },
];

export function getScimGuide(id: string | null | undefined): ProviderGuide | null {
  if (!id) return null;
  return SCIM_PROVIDER_GUIDES.find((g) => g.id === id) ?? null;
}
