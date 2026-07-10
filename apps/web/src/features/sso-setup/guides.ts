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
 *  - 'test'         — the final verify-your-login step
 */

export type StepKind = 'instructions' | 'import' | 'test';

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
  kind?: StepKind;
}

export interface ProviderGuide {
  id: 'entra' | 'okta' | 'google' | 'custom';
  name: string;
  blurb: string;
  /** Default group-claim attribute name this IdP emits (prefills the import form). */
  defaultGroupClaim: string;
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
    defaultGroupClaim: 'memberOf',
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
    defaultGroupClaim: 'groups',
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
        id: 'group-claim',
        title: 'Add the group attribute',
        intro:
          'In the same SAML settings, under "Group Attribute Statements": name it groups, filter "Matches regex" with .* (or a narrower filter for the groups you want to send).',
        note: 'The attribute NAME (groups) is what you enter as the group claim when connecting to Kortix.',
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
    defaultGroupClaim: 'groups',
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
          'On the "Google Identity Provider details" step, click Download metadata and keep the XML — you’ll paste it into Kortix at the connect step.',
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
          'On the attribute mapping step, under "Group membership" pick the groups to send and name the app attribute groups.',
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
    defaultGroupClaim: 'groups',
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
