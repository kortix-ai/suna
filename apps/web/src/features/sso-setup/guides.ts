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
  where: 'kortix',
  intro:
    'Paste the federation metadata from the previous step. Kortix registers your IdP and routes sign-ins for your email domain through it.',
  note: `Group claim is prefilled with ${claimHint} — it must match the claim name your IdP emits, or group sync silently finds nothing.`,
});

const testStep = (extra?: string): GuideStep => ({
  id: 'test',
  title: 'Test single sign-on',
  kind: 'test',
  where: 'kortix',
  intro:
    'Copy the sign-in URL below and open it in a PRIVATE / incognito window (so your own logged-in session doesn’t auto-complete the test), enter a test user’s work email, and complete the sign-in at your identity provider.',
  bullets: [
    'The test user must be one you assigned to the app — otherwise the IdP rejects the sign-in with a “not assigned” error.',
    'On success the user lands in Kortix and appears under Members on the account’s Identity page.',
    'Groups: if you left “Auto-provision groups” ON at the connect step (the default), your IdP groups appear automatically under Groups — just grant each one a project role. If you turned it off, map them yourself on the Identity page → SAML SSO card → “Group mappings” (IdP group name/ID → Kortix group).',
    'Either way a group confers NO access until you grant it a project role; changes in the IdP (add/remove from a group) apply on the user’s next sign-in.',
    ...(extra ? [extra] : []),
  ],
  warning:
    'If the sign-in fails: “not assigned” → assign the user to the app (assign-users step). An attribute/email error → recheck the email claim maps to the IdP’s login attribute (attributes step). Signed in but no groups → recheck the group claim NAME matches what you set at connect.',
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
        ],
        doneLabel: 'I’ve created a custom SAML app',
      },
      {
        id: 'metadata',
        title: 'Set identity provider metadata',
        kind: 'metadata-input',
        intro:
          'On the "Google Identity Provider details" step, click "Download metadata" and paste the XML file’s contents below to continue.',
        content: [
          {
            kind: 'image',
            src: '/sso-setup/google/metadata-1.png',
            alt: 'Google Identity Provider details step with the Download metadata button',
            schematic: {
              title: 'Add custom SAML app → Google Identity Provider details',
              rows: [{ label: 'Download metadata', as: 'button' }],
            },
          },
        ],
        note: "Google only offers the XML download — there is no hosted metadata URL. Come back to re-download it if you change the app's configuration later; Kortix reads whatever is in the file at import time.",
        doneLabel: 'I’ve added the identity provider metadata',
      },
      {
        id: 'basic-saml',
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
        title: 'Map user attributes',
        intro:
          'On the "Attribute mapping" step, click "Add mapping" for each row and select the matching Google category/attribute.',
        content: [
          {
            kind: 'claims-table',
            rows: [
              { name: 'primaryEmail', source: 'Basic Information > Primary email', required: true },
              { name: 'firstName', source: 'Basic Information > First name' },
              { name: 'lastName', source: 'Basic Information > Last name' },
            ],
          },
        ],
        doneLabel: 'I’ve mapped the user attributes',
      },
      {
        id: 'group-claim',
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

const scimTestStep = (opts: { extra?: string; content?: StepBlock[] } = {}): GuideStep => ({
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
    'The member/group counts below tick up, and in Entra’s Provisioning log every stage (Import, Scope, Match, Perform action) shows Success.',
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
    id: 'custom',
    name: 'Custom SCIM 2.0',
    blurb: 'Any SCIM 2.0-capable identity provider',
    config: {
      groupClaimName: 'groups',
      groupValueHint: 'Pushed groups are created in Kortix under their displayName.',
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
