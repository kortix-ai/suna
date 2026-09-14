// Generated from the user-visible fields in the SSO and SCIM guide catalogs.
export const GUIDE_TRANSLATION_KEYS: Readonly<Record<string, string>> = {
  '"Assign to People/Groups" makes the Assignments tab your allowlist: roll out team-by-team, and unassigning someone removes their Kortix access. There is no "sync everyone" toggle in Okta the way Entra has one — Assignments IS the scope, always.':
    'textcb8b75d64e2e',
  '"Sync only assigned users and groups" makes this app\'s Users and groups list your allowlist: roll out team-by-team, and unassigning someone removes their Kortix access. "Sync all users and groups" gives every person in your Entra tenant a Kortix account — fine for a small or dedicated tenant, rarely what a company tenant wants on day one.':
    'text9c3e31afd941',
  '"audience"': 'text40301f59f422',
  '"nameIdentifierFormat"': 'text93ff375b607b',
  '#1 Auth0 gotcha: two easy-to-miss values live inside the Settings JSON, not labeled fields — the audience (Entity ID) AND the NameID format. The addon defaults NameID to the Auth0 user_id (auth0|…), so without the emailAddress nameIdentifierFormat above, Kortix correlates on the wrong subject and every sign-in mis-identifies or fails.':
    'text896dc9e92487',
  '#1 JumpCloud gotcha: Test Connection fails because the test-user email already exists in Kortix — it must be a brand-new address. (And click "Activate", not "Save", during that step.)':
    'text79c6ba1d813d',
  '#1 OneLogin gotcha: the "ACS (Consumer) URL Validator" is a regex, not a plain URL. Escape the dots and anchor it so it matches the ACS URL exactly, or login fails with no clear error.':
    'text582ee45bd6ee',
  '#1 OneLogin gotcha: users seem to sync but nothing lands in Kortix — the actions are stuck in the Provisioning "pending" queue because "Require admin approval" is still checked. Uncheck it for Create/Update/Delete (or approve the queue).':
    'text5bdaf14744e5',
  '#1 PingOne gotcha: everything looks configured but zero users sync — the CONNECTION toggle is still off (it defaults off), or PingOne is sending its internal username instead of the email. Enable the connection toggle, map "Username" → "Email Address", and set the filter `userName eq "%s"`.':
    'textad73038522f6',
  '#1 failure mode: Test Connection fails. Almost always a hand-typed or truncated Tenant URL — re-copy it exactly from above (it is not the regular Kortix API URL and has no /v1 suffix). Assigning a whole GROUP (rather than individual users) needs Entra ID P1/P2; on Free, assign users one at a time.':
    'texta442c279fce0',
  '+ /saml-metadata': 'text00495b4b8c8a',
  '+ Add New Application': 'text3c0b45ea3c2d',
  '+ Add user/group': 'textdcb300b85f0d',
  '+ New application': 'textef49f1424340',
  'A OneLogin user can only sign into an app that is assigned to them — an unassigned user is rejected at sign-in ("app not available"). Assign your test user before testing.':
    'text14f1b9941b3f',
  'A provisioning Rule decides which users and groups this connection pushes.': 'textb1bfc65c3e1a',
  'A pushed user appears under Members (as a pending invite until their first sign-in).':
    'text1955194aaa79',
  'A user is provisioned only once this SCIM app is assigned to them; group membership is pushed with a Rule.':
    'text726c8715bf2e',
  'ACS (Consumer) URL': 'text741f24c3028a',
  'ACS (Consumer) URL Validator': 'text6dcee355767d',
  'ACS / Reply / Single sign-on URL → the Reply URL (ACS) below.': 'text74d1bd3b3726',
  'ACS URL': 'textdb2994c1db34',
  'ACS URL → the Reply URL (ACS) below.': 'text7be601ef7143',
  'ACS URLs — imported for you': 'textcfed046a62cb',
  'API Status': 'textbd966864b912',
  'API Status shows a green "Enabled", the "SCIM Username" parameter maps to Email, and provisioning is enabled without the admin-approval hold.':
    'textd83a0d814c59',
  'API Token': 'textc85b0e36e937',
  'API Type': 'text72e7cc4c4f1c',
  'Access Entity ID': 'text22e88caadb30',
  'Access → Applications': 'text90d42949dc52',
  'Access → SSO Applications': 'textc791af467bb4',
  Action: 'text64cff1319d2f',
  Activate: 'text24433c70eba5',
  'Activate / Save': 'textdf55b4b9b6f5',
  'Add Assignment': 'textd83265a96352',
  'Add a OneLogin SCIM connector and point it at the two values shown above.': 'text0399741890df',
  'Add a SaaS application in Cloudflare Access': 'text1ca8b28b3e6a',
  'Add an access policy': 'text8b9965f7aaa5',
  'Add an application': 'text1095ddb6dcd8',
  'Add an application → SaaS · SAML → SAML attribute statements': 'textab1dafc84ca4',
  'Add an application → SaaS · SAML → app configuration': 'text96b35ed9b0a7',
  'Add an application → SaaS · SAML → identity providers': 'text465eb6f2fb59',
  'Add an application → SaaS · SAML → policies': 'text38fa4a9dc87c',
  'Add an application → Select type': 'textfaa9be96725c',
  'Add an application → app credentials': 'text81353bbf47b1',
  'Add app → Add custom SAML app': 'text539a563faa17',
  'Add attribute': 'textdd77952c5416',
  'Add custom SAML app → App details': 'text6bc831a3c619',
  'Add custom SAML app → Attribute mapping': 'textb7396994492d',
  'Add custom SAML app → Google Identity Provider details': 'textbdc8e80f18fe',
  'Add custom SAML app → Service provider details': 'texta8df8792996a',
  'Add one more parameter with Field name "groups". In its Value dropdown pick "User Roles" (that is the entry that emits the user’s role names — OneLogin’s separate "Groups" concept is a different attribute). Tick "Include in SAML assertion", AND enable the multi-value flag so every role is sent as its own value.':
    'text65511e543224',
  'Add the group attribute': 'texta4ed5a7709cb',
  'Add the group claim': 'text0050aeb4cf77',
  'Add the groups attribute': 'text0789d42d0a2c',
  'Add the groups parameter': 'text09129008d8d1',
  'Advanced Settings → Endpoints': 'text80201ebafed7',
  'Advanced options → Customize the name of the group claim': 'texte493d2f8af71',
  'Advanced options → check "Customize the name of the group claim" → Name: memberOf.':
    'text2c89f2359d69',
  'After Save, Entra pops its own "Test single sign-on with Kortix?" dialog — choose "No, I\'ll test later". Kortix isn\'t connected yet; the guided test comes at the last step.':
    'text4fe4db0a0d92',
  'After saving the rule, click "Reapply entitlement mappings" (app → Users → More Actions) to push groups to users who are ALREADY assigned — otherwise existing members’ groups only sync on their next change.':
    'text8ab09c3fe5ed',
  'Any SAML 2.0 identity provider': 'textc5876793b9bd',
  'Any SCIM 2.0-capable identity provider': 'text988c3f87ad11',
  'App Federation Metadata Url': 'text23c1c031ead7',
  'App attribute': 'textdcc3f936c2d4',
  'App icon': 'text56244b12a992',
  'App logo (optional)': 'textf6adb9115a27',
  'App name': 'texte6ad39968537',
  'App page User access section with the service toggle': 'text7dd0d9729331',
  'App → Authentication → Login methods': 'text9e1b76d01c46',
  'App → Policies → Add a policy': 'text43104a3e8715',
  'App → Provisioning → Configure API Integration': 'text99770dacc0d9',
  'App → Sign On tab → "Identity Provider metadata" link': 'text5e74adcd4bfb',
  'Application Callback URL': 'text355ee5138eb8',
  'Application Callback URL (ACS)': 'text2804592863da',
  'Application name': 'text09526e9d005a',
  'Application settings page with the Sign On tab selected': 'text05fb96e3f84d',
  'Application type': 'textaccd1ec5e88d',
  'Application username': 'texte0bde186128a',
  'Application → Addons': 'text7bc709b6d604',
  Applications: 'text98e33b0f3104',
  'Applications page with the Create App Integration button': 'texte8602165f856',
  'Applications → Add App': 'textcea43cbea830',
  'Applications → Applications': 'text13502ac4da41',
  'Applications → Applications → "Add App" → search "SCIM" → pick "SCIM Provisioner with SAML (SCIM v2 Core)" → name it "Kortix" → Save. Then open the app’s "Configuration" tab.':
    'text2f300e91c591',
  'Apps → Web and mobile apps': 'text864e2d680b0c',
  'Assertion Consumer Service URL': 'text5dacfb655b9b',
  Assign: 'text8ece895c9b32',
  'Assign Group to App': 'text593e3823343a',
  'Assign groups to the SAML app': 'textf4152f065d72',
  'Assign people and push groups': 'text65ca8fb19ba8',
  'Assign the app: Users → open a user → "Applications" → "+" → add "Kortix" (or assign the app to a Role so everyone in that Role is provisioned).':
    'text838198290fbc',
  'Assign the appropriate groups to the application. When you are finished, click "Done". Only assigned users can sign in through this application.':
    'text0afbe82103f0',
  'Assign to Groups': 'textebafb00209f1',
  'Assign to Groups dialog with groups being assigned': 'textcf5c8ddd36f5',
  'Assign to People': 'text1a82cd072e37',
  'Assign users and groups': 'texte64eb6b9ded3',
  'Assign users and push groups': 'text077d12b54cea',
  'Assign users to the app': 'text1677a1d1350d',
  'Assigning a whole group (rather than individual users) requires Entra ID P1/P2.':
    'text80b46e399ad1',
  'Assignment is the allow-list: only users/groups assigned to this application get provisioned. In the left nav click "Users and groups" → "+ Add user/group" → click "None Selected" under Users → pick a user (recommended: assign yourself first so you can watch yourself arrive) → "Select" → "Assign".':
    'textd102110d1f10',
  'Assignments is the allow-list: only assigned people/groups get provisioned. Push Groups is separate — it syncs group membership for groups you explicitly push.':
    'textbf2ffcbdcaaf',
  'Assignments tab with the Assign dropdown open': 'text39587cdd0983',
  'Assignments tab → "Assign" → "Assign to People" (or "Assign to Groups") → pick who should be provisioned → "Done".':
    'text74014555a26d',
  'Attribute Mapping': 'text2b977e24582e',
  'Attribute Mapping → groups': 'text4d7b5a2ac064',
  'Attribute mapping': 'text1c57faca2eb3',
  'Attribute mapping step Group membership section with the groups app attribute':
    'textf1762d8d0054',
  'Attribute mapping → Group membership': 'text470385859f0e',
  'Attribute mapping → Group membership (optional)': 'text47ca51ceb36a',
  'Attributes & Claims': 'text1781dd4bb649',
  'Attributes & Claims list with the configured claims': 'text131829d7a832',
  'Attributes & Claims section with the Edit button': 'text98ea5e0b6642',
  'Attributes & Claims → Add a group claim': 'text850bf7a62920',
  'Audience (EntityID)': 'textdcafafe0042d',
  'Audience / SP Entity ID → the Identifier (Entity ID) below.': 'text275b372f85bc',
  'Audience URI (SP Entity ID)': 'text1fc6f3927039',
  'Auth0 Addons tab with the SAML2 Web App toggle': 'text79a3c4f34dfd',
  'Auth0 Advanced Settings Endpoints tab with the SAML Metadata URL': 'text2c8131c613e7',
  'Auth0 Applications list': 'textd9e5e615d8e5',
  'Auth0 Dashboard → Applications → Applications': 'textc999d58b84d1',
  'Auth0 SAML2 Web App Application Callback URL field': 'text09c8f9190e3a',
  'Auth0 SAML2 Web App Settings JSON with the audience and NameID values': 'text77d50891d3e8',
  'Auth0’s SAML2 Web App addon does NOT send groups by default — you add a groups claim with an Auth0 Action/Rule. Until then, only email + name arrive.':
    'text4bc37c88fbcf',
  'Authentication Method': 'text44ff9dbcb9c4',
  'Authentication Mode': 'textf65f62a09460',
  'Automatic provisioning from JumpCloud': 'text5569127c2d09',
  'Automatic provisioning from Okta': 'textabf1df16fc52',
  'Automatic provisioning from OneLogin': 'textafdc7d79dccb',
  'Automatic provisioning from PingOne': 'textfc967a19be0b',
  'Automatic provisioning from your Entra tenant': 'textfba1e79abe38',
  'Automatic provisioning requires Entra ID P1/P2 (a trial works fine).': 'text840d62d0584a',
  'Back in "Provisioning" → "Settings", set "Scope" to "Sync only assigned users and groups" — it only appears here after credentials are saved. Then click "Start provisioning" at the top of the Provisioning overview page (or "Provision on demand" to push one assigned user instantly instead of waiting for the ~40-minute cycle).':
    'text9224d9e82502',
  'Back in Kortix, watch the live status below while you push or wait for the sync — no need to tab back and forth to check.':
    'text18d93a94d067',
  'Back on the app page, select "User access", set the service to ON for the org units or groups that may sign in, then click "Save".':
    'textf83190e0bc8c',
  'Back on the application’s Settings page, expand "Advanced Settings" → "Endpoints" tab, and copy the "SAML Metadata URL". Paste it below.':
    'text113d9329566e',
  'Base URL': 'text70589413a3c9',
  'Basic SAML Configuration': 'textbf374f3c41a2',
  'Basic SAML Configuration panel with the Identifier and Reply URL filled in': 'text878fecea2993',
  'Basic SAML Configuration section with the Edit button': 'text233d0d69a6c8',
  'Basic SAML configuration': 'textf2cb80a49d86',
  'Before you start': 'text74e492d5d0df',
  'Below is how a claim looks in the Azure claim editor — make sure the "Namespace" value ends in /claims.':
    'textaba6d486b5df',
  'Belt and braces: the NameID already carries the email, but an explicit email attribute keeps sign-in working if the NameID format ever changes.':
    'texta3dec1ea345e',
  'Bind a user group for access': 'text09efedd0899d',
  'Bind groups to provision users': 'text83288ebdced3',
  'Binding here does double duty: it grants sign-in access AND selects which groups get sent in the "groups" claim you enabled above.':
    'textd2145c294689',
  'Browse Microsoft Entra Gallery → Create your own application': 'text7bd1f1dd22d6',
  'Cadence depends on your IdP — most push changes as they happen; some run scheduled cycles. Check its provisioning log if nothing arrives.':
    'textf52bfe43b914',
  'Callback URL and audience': 'text4818598bb2d8',
  'Check "Use this for Recipient URL and Destination URL". Set "Name ID format" to EmailAddress and "Application username" to Email — Kortix matches accounts by email.':
    'text6da390b94eb6',
  'Choose the "SaaS" application type, then select SAML (not OIDC) as the protocol. Give it a name such as "Kortix".':
    'text8c64de57e442',
  'Choose which identity provider(s) this application accepts — the upstream login method(s) you set up in the first step. Restrict to the one(s) you intend, or allow all configured methods.':
    'textff536bcd78f9',
  'Click "Add user/group", click "None Selected" under Users and groups, select the users or groups that should sign in to Kortix, click "Select", then click "Assign".':
    'text7423c5dad8fc',
  'Click "Create App Integration".': 'textd800b1eb8a84',
  'Click "Show legacy configuration" to expand it, then click "Edit" next to "Profile attribute statements".':
    'texte98385522946',
  'Cloudflare Access is connected to my IdP': 'textefc784539cbc',
  'Cloudflare Access passes email by default. Add the other attributes Kortix reads — id, firstName, lastName — as "SAML attribute statements": each is a Name plus the upstream IdP claim it maps to (a dropdown of your login method’s claims).':
    'textf27c4fdb823a',
  'Cloudflare Access policy configuration with rules': 'textdd69a8f7d8d9',
  'Cloudflare Access sits BETWEEN Kortix and your real identity provider: it authenticates users against your IdP, then presents itself to Kortix as a SAML IdP. So set up the upstream connection first — in Zero Trust → Settings → Authentication, add a login method (Okta, Entra, Google, …) per Cloudflare’s docs.':
    'text514650746440',
  'Cloudflare Add an application dialog with the SaaS type selected': 'text2191d96dabc7',
  'Cloudflare SAML attribute statements showing the groups attribute': 'text8e713f9ca03d',
  'Cloudflare SaaS SAML app configuration with Entity ID and ACS URL fields': 'text77d1cb4e55a5',
  'Cloudflare SaaS app SAML attributes section with id, firstName, lastName added':
    'text3385bcdb1cc1',
  'Cloudflare SaaS app credentials with the SSO endpoint, Access Entity ID and public key':
    'textbf1ebcb141c8',
  'Cloudflare Zero Trust Access Applications page with Add an application': 'text741f8fc72c03',
  'Cloudflare Zero Trust → Settings → Authentication → Login methods': 'text722467f3efa2',
  'Cloudflare forwards the upstream IdP’s group NAMES on a "groups" SAML attribute (sent automatically for Okta, Entra ID, Google Workspace, and GitHub) — map those names in Kortix.':
    'text1a146e36d3fc',
  'Cloudflare requires at least one Access policy or NOBODY can reach the app. Add a policy that allows the users/groups who may sign in (e.g. Action: Allow, Include: Emails ending in your domain, or a specific group).':
    'textf060ffc7f383',
  'Cloudflare selecting the identity provider login methods for the app': 'textf8763a5f7793',
  Configuration: 'textb332c3492d5e',
  'Configuration → API Connection': 'textcb08253e344c',
  'Configuration → SAML': 'text9440034dd37f',
  'Configuration → SAML attributes': 'texteabe2462bc71',
  'Configure SAML': 'text21fea3a172b2',
  'Configure SAML attributes': 'textff29c6cba4c4',
  'Configure SAML step with the Single sign-on URL and Audience URI fields': 'text24c5c392057f',
  'Configure SAML → Name ID format': 'textce47a3c13d0d',
  'Configure attributes and claims': 'textb48301ea5f6d',
  'Configure login methods': 'text828541c6a933',
  'Confirm the groups attribute': 'text9961fdd19fe8',
  'Connect Cloudflare Access to your identity provider': 'text172ebbf578c6',
  'Connect SAML SSO first so provisioned users can sign in.': 'text365642325b8f',
  'Connect SAML SSO first — Directory Sync can create and remove accounts, but users still need SSO to sign in.':
    'text0fb3ca669c74',
  'Connect SAML SSO first — provisioning creates accounts, but users still need SSO to sign in.':
    'texte1d84c99737d',
  'Connect to Kortix': 'textb5307a649d34',
  'Connections → Applications → +': 'text253923d0f0c5',
  Continue: 'text31fbef162594',
  Copy: 'texte21f935f11d7',
  'Copy Metadata URL': 'text3293f4f01c0a',
  'Copy the "Identifier (Entity ID)" and the "Reply URL (Assertion Consumer Service URL)" below and paste them into the "Basic SAML Configuration" panel — mark the Identifier as Default, and set "Sign on URL" to your Kortix sign-in page. Leave Relay State and Logout URL empty. Click "Save" and close the edit panel.':
    'text775ddc2119ab',
  'Copy the sign-in URL below and open it in a PRIVATE / incognito window (so your own logged-in session doesn’t auto-complete the test), enter a test user’s work email, and complete the sign-in at your identity provider.':
    'text8eb1b3140390',
  Create: 'text4759498ac2a7',
  'Create App Integration': 'text97b8900228c8',
  'Create SAML Integration → Configure SAML': 'text28f8cdd421fb',
  'Create SAML Integration → General Settings': 'text6cf5b0c4454f',
  'Create Users': 'texta5b75959c891',
  'Create a "SCIM Outbound" provisioning connection and point it at the two values shown above.':
    'textab8fcb695b84',
  'Create a SAML 2.0 application in your identity provider and give it these service-provider values.':
    'text6c4db128146d',
  'Create a SAML integration': 'text5de37d9dd94a',
  'Create a custom SAML app': 'textf7579e0cf77c',
  'Create a new app integration': 'text128ec1ece532',
  'Create a new app integration dialog with SAML 2.0 selected': 'text80d5d48b94be',
  'Create an enterprise application': 'text46c0ee68c43d',
  'Create the following attribute mapping statements:': 'texta0102232ab2b',
  'Create your own application panel with the Non-gallery option selected': 'textcdd3dd706df5',
  'Custom Application': 'text29151178dbf3',
  'Deactivate Users': 'textb2a81951f5ec',
  'Deactivating the user in the IdP removes their membership and revokes their tokens.':
    'textd931fd53e0fa',
  'Declare Redirect Endpoint': 'text4a1de0e4a5a8',
  'Directory Sync pushes users and groups from Entra proactively — deactivations apply without waiting for a sign-in. It reuses the same enterprise application you already registered for SAML SSO; nothing new to create.':
    'textca3bcc681e99',
  'Display Name': 'text18d67c992b71',
  'Display names and assigning groups to the app require Entra ID P1/P2 (check yours: Entra admin center → Overview → the License row). On the Free tier pick "Security groups" + "Group ID" instead — groups arrive as Object IDs (GUIDs; copy a group\'s Object ID from Entra ID → Groups) and you map those GUIDs in Kortix. EITHER WAY, you must still rename the claim to memberOf under "Advanced options" → "Customize the name of the group claim" — skipping the rename is the #1 cause of groups silently not syncing.':
    'text6cf5816a3fba',
  'Do NOT enable the Advanced settings "SAML attribute transform (JSONata)" to build groups — a JSONata transform OVERRIDES all your SAML attribute statements, wiping out the email/id/firstName/lastName mappings from the previous step. Use plain attribute statements only.':
    'text292ad1466ce9',
  Done: 'text11a6767d5674',
  'Download metadata': 'texta26a9d5ddec5',
  'ENABLE the connection itself: click the toggle at the top of the connection’s details panel so it turns blue. A saved-but-disabled connection provisions NOTHING even with an Active rule — this is the easiest step to miss.':
    'textea984f35d1fe',
  Edit: 'text464c4ffd019e',
  'Either way a group confers NO access until you grant it a project role; changes in the IdP (add/remove from a group) apply on the user’s next sign-in.':
    'text13b6db11e086',
  'Emit a group attribute (e.g. named groups) listing the user’s groups.': 'texted1d87390f65',
  Enable: 'text5342e09f2729',
  'Enable API integration': 'text3450d7108b3f',
  'Enable Create Users, Update User Attributes, and Deactivate Users → Save.': 'textf9debe3e14a5',
  'Enable application': 'textca519bb35fbb',
  'Enable connection (toggle)': 'texta70e90bd4809',
  'Enable provisioning': 'textf1fd853c3274',
  'Enable provisioning/sync in your IdP’s SCIM client and scope the users/groups to push — it then runs on the IdP’s own schedule.':
    'text7a33b568e0b2',
  'Enable the CONNECTION toggle (top of its details panel, turns blue) AND set the provisioning rule to Active — both are required; a saved-but-disabled connection provisions nothing.':
    'text3d57a1bcb5d9',
  'Enable the SAML2 Web App addon': 'textadf8ef8c6554',
  'Enable the app first — a disabled PingOne app rejects sign-ins even with correct metadata.':
    'text5502881e0479',
  'Enable the group attribute': 'texte39637abfc85',
  'Ensure the claims listed below are configured. Most exist by default — the one you almost always have to CHANGE is "emailaddress": edit it and switch its source attribute from user.mail to user.userprincipalname.':
    'text47d57a730783',
  'Enter an app name, such as "Kortix" — optionally upload an app icon. Click "Continue".':
    'texte97e79e16e22',
  'Enter an appropriate app name, such as "Kortix". Select the "Integrate any other application you don\'t find in the gallery (Non-gallery)" option. Click "Create".':
    'textdeb59ebdac18',
  'Enterprise application → Overview': 'texte4334820483a',
  'Enterprise applications → your app → Provisioning': 'textee52686fe92b',
  'Entity ID': 'text8ffc09d9f8d7',
  'Entity ID → the Identifier (Entity ID) below.': 'text3c67025c4b3a',
  'Entra ID → Enterprise applications': 'text445d14bb67ec',
  'Entra Provisioning Admin Credentials section with Tenant URL, Secret Token, and Test Connection':
    'text8a88857d117b',
  'Entra Provisioning overview page toolbar with Start provisioning and Provision on demand buttons':
    'textcbb8cd27c44c',
  'Entra Provisioning overview showing a completed cycle with Import, Scope, Match, and Provision all reporting Success':
    'text7bb79899f2c5',
  'Entra Users and groups panel with Add user/group open and a user selected for assignment':
    'text5775c8f9216d',
  'Entra admin center — Enterprise applications list with New application highlighted':
    'textdad35b178f11',
  'Entra enterprise application overview page with the Single sign-on, Provisioning, and Users and groups tabs in the left nav':
    'texta0a8a236f471',
  'Entra maps email to user.mail by default, which is EMPTY for accounts without a mailbox (any *.onmicrosoft.com user). An empty email breaks sign-in with no useful error. The UPN (User Principal Name — the username people sign in with, e.g. jane@yourtenant.onmicrosoft.com) is always populated, which is why every mapping here points at it.':
    'text166ca2c8086b',
  'Entra provisioning attribute mappings list with the userName to user.userprincipalname row highlighted':
    'text34248f2d53e1',
  'Entra runs its scheduled provisioning cycle roughly every 40 minutes — changes apply on the next cycle, or instantly with "Provision on demand".':
    'text93b4519b9be9',
  'Entra sends group Object IDs (GUIDs) by default — map those GUIDs, or emit display names via "Groups assigned to the application" (needs Entra ID P1/P2).':
    'texta89c8f1d28bf',
  'Entra → Provisioning → Admin Credentials': 'textc4f7c4c468d5',
  'Expand "Mappings" → "Provision Microsoft Entra ID Users". The one row that matters: "userName" must map to source attribute "user.userprincipalname" — that is how Kortix matches the SCIM user to a Kortix account. Leave the default "objectId → externalId" mapping as-is (that\'s how Entra recognizes a record it already pushed on later syncs) and leave the rest at their defaults.':
    'textb7b62fb8ba41',
  'Export your IdP’s SAML metadata — paste its metadata URL, or switch to Manual and paste the raw XML. It carries into the connect step automatically.':
    'text74d751461c37',
  'Field name': 'text2f5574bc5e68',
  'Fill it from the values above: "SCIM connector base URL" = the Tenant URL; "Unique identifier field for users" = userName; "Authentication Mode" = HTTP Header, and paste the secret as the API Token. Click "Test API Credentials", then "Save".':
    'texta230d18c2a87',
  Filter: 'text638e249f4a15',
  'Find groups by name': 'text57530d39031c',
  Finish: 'texta6c7a84baa67',
  'First name': 'text702ef921ed1d',
  'For Okta, Microsoft Entra ID, Google Workspace, and GitHub, Cloudflare Access sends a "groups" SAML attribute automatically — there is nothing to add here, just confirm it is present. For any other upstream IdP, add one SAML attribute statement with Name "groups" and pick the IdP claim that carries group membership.':
    'text5918414053b3',
  'For a single tester: Users → open the test user → Applications tab → "+" → add "Kortix". For a team: Users → Roles → create or edit a Role that includes the Kortix app, then add members to that Role.':
    'textb02bf1168f8c',
  'Four things, in order: paste credentials, check the one mapping, assign users, then start. Both values you need are shown above.':
    'textfb1f44091b66',
  'General Settings step with the app name field': 'textc4926d7d3934',
  'Go to Integrations → Provisioning → "Rules" tab → open (or add) the rule for this connection → its "Directory" tab. Scope which people are provisioned with a User Filter ("Add Condition" on a population or user attribute) and/or by selecting Populations.':
    'text9dd1bf88862d',
  'Google Admin console Web and mobile apps page with Add app menu open': 'text1e67cb5d7376',
  'Google Admin → Apps → Web and mobile apps': 'texta834fe0854ae',
  'Google Identity Provider details step with the Download metadata button': 'text9d323314631a',
  'Google can take up to 24 hours to fully propagate an access change — a user reporting "not assigned" right after you flip this on may just need to wait.':
    'text5dc3d8d9d728',
  'Google custom SAML app Attribute mapping step with primaryEmail, firstName and lastName mapped':
    'text26bee86cde97',
  'Google custom SAML app dialog with the App name and icon fields': 'text9145379b9103',
  'Google groups': 'text085c8149fd05',
  "Google only offers the XML download — there is no hosted metadata URL. Come back to re-download it if you change the app's configuration later; Kortix reads whatever is in the file at import time.":
    'textcf184a1c054a',
  'Google only sends groups you EXPLICITLY select here (max 75). Add every group you plan to map in Kortix — an unselected group is silently omitted from the claim.':
    'textb963bfc5b85d',
  'Google sends group NAMES — and only for the groups you explicitly selected in the mapping (up to 75). A group you forgot to select is silently never sent.':
    'text4ba9e26cc819',
  'Group Attributes': 'text12abcfe75cda',
  'Group Claims': 'text43b4bc80b7b1',
  'Group Claims panel in Attributes & Claims': 'text4dc6cc22854d',
  'Group attribute statements': 'text49942009b705',
  'Group attribute statements form below the profile attribute statements': 'text57d08d24adb8',
  'Group claim is prefilled with groups — it must match the claim name your IdP emits, or group sync silently finds nothing.':
    'text3d5d4f148324',
  'Group claim is prefilled with memberOf — it must match the claim name your IdP emits, or group sync silently finds nothing.':
    'text6940d5a739fd',
  'Group membership for a user who hasn’t signed in yet is held on their invite and applies automatically at their FIRST sign-in — an empty group before that is expected, not a failure.':
    'text173b12591349',
  'Group values arrive exactly as your IdP emits them (names or IDs) — create Kortix mappings from what actually arrives.':
    'text664528a0a7ad',
  'Groups Resource': 'textaa000c983975',
  'Groups are off by default — without this mapping PingOne sends none. The attribute name (groups) must match the connect-step claim.':
    'text9c439825da55',
  'Groups pushed from OneLogin Rules are created in Kortix under their OneLogin names.':
    'text2f6c00ce1d58',
  'Groups pushed via Push Groups are created in Kortix under their Okta names.': 'text437dee26bc75',
  'Groups pushed via SCIM are created in Kortix under their Entra display names.':
    'text284687df8e12',
  'Groups: if you left “Auto-provision groups” ON at the connect step (the default), your IdP groups appear automatically under Groups — just grant each one a project role. If you turned it off, map them yourself on the Identity page → SAML SSO card → “Group mappings” (IdP group name/ID → Kortix group).':
    'textbef5c2e7cce8',
  'Groups: the default SAML2 Web App addon sends only email + name. To sync groups, add an Auth0 Action/Rule that emits a claim NAMED exactly "groups" (matching the connect-step claim). Auth0’s built-in group attribute URI "http://schemas.xmlsoap.org/claims/Group" will NOT match — map it to "groups". Then map those names in Kortix.':
    'textf01e66b8c61a',
  'IdP Entity ID': 'text14a4ab8bf5c1',
  'IdP Metadata URL': 'text4ebe47eb8d93',
  'IdP claim': 'text4ecdccd54ed0',
  'Identifier (Entity ID)': 'text8e5381229b65',
  'Identity Management → "Test Connection" → "Activate", then bind user groups on the "User Groups" tab — bound groups and their members push automatically.':
    'text9136c4647e36',
  'Identity Management → Configuration': 'text9d6304b7f8dc',
  'Identity providers': 'text3965375163f1',
  'If the sign-in fails: “access denied” by Cloudflare → widen or add an Access policy (the policy step). Bounced at the IdP → check the upstream login method (the first step). Signed in but no groups → confirm the “groups” attribute is present (group step) and its NAME matches the connect step.':
    'textb948f8d45e30',
  'If the sign-in fails: “not assigned” → assign the user to the app (assign-users step); on Google this can also be propagation delay right after you turn the app on, so wait a few minutes and retry first. An attribute/email error → recheck the email claim maps to the IdP’s login attribute (attributes step). Signed in but no groups → recheck the group claim NAME matches what you set at connect.':
    'text1cdceed6417e',
  Import: 'text2cff9baabf56',
  'Import from URL → metadata URL (paste this)': 'text79524f26f8e3',
  'Import the SP metadata': 'textcda9d3861618',
  'In "Attribute Mapping", first set the SAML Subject (the "saml_subject" row / Name ID) to "Email Address" — it defaults to "User ID" (a GUID), but Kortix correlates accounts by email. Then add these outgoing SAML attributes (Kortix name → PingOne source):':
    'textf69dc87b39bc',
  'In "Single sign-on", scroll to section 3 "SAML Certificates" and copy the "App Federation Metadata Url". Paste it below to continue.':
    'text1fc6dc4bd320',
  'In Cloudflare Zero Trust: Access → Applications → "Add an application".': 'text4e8f07bf6cf0',
  'In JumpCloud a user can only reach an SSO app if a user GROUP they belong to is bound on the app’s "User Groups" tab — there is no per-user assignment. Bind a group before testing, or the sign-in is rejected as "not assigned".':
    'text6c47e72cde49',
  'In the "Create a new app integration" dialog, select "SAML 2.0". Click "Next".':
    'text4cf9cff6cc72',
  'In the "Settings" JSON object below the callback field, set TWO things: (1) "audience" = Kortix’s Entity ID, and (2) force the NameID to the user’s email — it defaults to the opaque Auth0 user_id (auth0|…), which Kortix can’t correlate. Add: "audience": "…/saml/metadata", "nameIdentifierFormat": "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress", "nameIdentifierProbes": ["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"]. Then scroll down and click "Enable".':
    'texteca0eeacbef7',
  'In the Auth0 dashboard: Applications → Applications → open (or create) the application for Kortix. Creating a new one? Choose "Regular Web Application" — the SAML2 addon works regardless of type, but this avoids second-guessing the picker.':
    'text057a35b34fcb',
  'In the Google Admin console (admin.google.com): Apps → Web and mobile apps → Add app → Add custom SAML app.':
    'textcf2e8758b651',
  'In the JumpCloud admin console: Access → SSO Applications → "+ Add New Application" → "Custom Application" (search "Custom SAML App") → "Configure SSO with SAML" → name it "Kortix". This opens the app’s SSO tab.':
    'text88de2bdc69eb',
  'In the Okta admin console, open the app → General → App Settings → Edit.': 'text8f98d1ea9df6',
  'In the OneLogin admin console: Applications → Applications → "Add App" (top-right) → search the catalog for "SAML Custom Connector (Advanced)" → select it → set the Display Name to "Kortix" → Save.':
    'text65390ee5e47f',
  'In the PingOne admin console: Connections → Applications → open the app for Kortix, or click "+" to add one: enter the name "Kortix", choose the "SAML Application" type (not OIDC/SPA/Worker/Native), then Configure.':
    'text991f5a050362',
  'In the addon’s Settings modal, paste Kortix’s ACS URL into "Application Callback URL". The Entity ID is NOT a form field — it goes inside the JSON.':
    'text33fd52cfd6ec',
  'In the end, it should look like this. Click "Save".': 'texta5b8713876f9',
  'In the left navigation menu, expand the "Applications" section and select the "Applications" tab.':
    'texta3dd2ebbbe9f',
  'In the left navigation menu, expand the "Entra ID" section. Select the "Enterprise apps" tab. Click "New application".':
    'textf373d63f8a71',
  'In the left navigation menu, select "Users and groups". Only assigned users can sign in through this application.':
    'text7110008d300a',
  'In the left navigation menu, select the "Single sign-on" tab. Click on the "SAML" tile.':
    'text283cf1838c17',
  'In the same "Show legacy configuration" panel, under "Group attribute statements", add: Name groups, filter "Matches regex" with .* (or a narrower filter for just the groups you want to send). Click "Save".':
    'textfccf4ccb4995',
  'In your identity provider’s SCIM client, paste the two values shown above: "Base / Tenant URL" is the Tenant URL (the IdP appends /Users and /Groups), and the Bearer token is the secret.':
    'text131a9516440b',
  Include: 'text7285576bdacf',
  'Include in SAML assertion': 'text1f6d55a46a7c',
  "Integrate any other application you don't find in the gallery (Non-gallery)": 'text301e9be79f51',
  'Integrations → Provisioning → "+ New Connection" → on the "Identity Store" line click "Select" → choose the "SCIM Outbound" tile → "Select". Name it "Kortix", then "Configure Authentication".':
    'text34bd3f65ba58',
  'Issuer URL': 'text4d03ba8a838f',
  'I’ve added a SaaS SAML application': 'text57404231b355',
  'I’ve added an access policy': 'text09993f2060aa',
  'I’ve added the SAML attributes': 'text44af6d2c691a',
  'I’ve added the groups attribute': 'texta37467ceafaa',
  'I’ve added the groups parameter': 'textfc1a1670a6e0',
  'I’ve added the identity provider metadata': 'textaaa072ad6fc2',
  'I’ve added the identity provider metadata URL': 'text546dc281747b',
  'I’ve added the memberOf group claim': 'text83c13e7be703',
  'I’ve assigned people and pushed groups': 'text70bbefde2428',
  'I’ve assigned the test user to the app': 'text950302156eb7',
  'I’ve assigned users and groups': 'texte92fed3bd6c2',
  'I’ve assigned users and pushed groups': 'text36001b0efbb0',
  'I’ve assigned users to the application': 'text3835b7065fba',
  'I’ve bound a user group to the app': 'textce3fbb995f0b',
  'I’ve bound the groups to provision': 'textadddcf5efc23',
  'I’ve chosen the login methods': 'text2dc82c9cc859',
  'I’ve completed basic SAML configuration': 'text1b3a3906ef41',
  'I’ve configured the SAML attributes': 'textc320da0e8ab9',
  'I’ve configured the SAML settings': 'text5d08a2b527a6',
  'I’ve configured the attributes and claims': 'textd071fb666276',
  'I’ve configured, mapped, assigned, and started provisioning': 'text386ad6b22698',
  'I’ve confirmed the groups attribute': 'textda77e2a62e07',
  'I’ve connected and activated Identity Management': 'text43826188c706',
  'I’ve connected and enabled provisioning': 'text7b988785d863',
  'I’ve created a SAML app integration': 'text8cc5e95eab10',
  'I’ve created a custom SAML app': 'text8ba58b8ca233',
  'I’ve created an enterprise application': 'text0df3614110d5',
  'I’ve created the SAML connector app': 'textcca598f05e1c',
  'I’ve created, enabled, and tested the SCIM connection': 'texte5a4af9b350f',
  'I’ve enabled and connected SCIM': 'text134ebe5b7d40',
  'I’ve enabled the SAML2 Web App addon': 'text4073b723c85b',
  'I’ve enabled the group attribute': 'textfbd29257121c',
  'I’ve entered the SSO configuration': 'text9da9bb2c2859',
  'I’ve entered the service-provider details': 'textcba321bae184',
  'I’ve filled in the configuration': 'text8fe59e9c75b0',
  'I’ve imported the SP metadata': 'textc87078ee4a24',
  'I’ve mapped the attributes': 'textcc2551ee58e7',
  'I’ve mapped the parameters': 'texta4154d76815f',
  'I’ve mapped the user attributes': 'textd0c559058d8c',
  'I’ve opened the SAML application': 'text7a9decd79093',
  'I’ve opened the SSO application': 'text7bf1b0c50188',
  'I’ve opened the application': 'textae52c06a79a3',
  'I’ve scoped users, selected groups, and activated the rule': 'textbad347716ab2',
  'I’ve set the callback URL, audience, and NameID': 'text5d28a8e6bc88',
  'I’ve turned on the sync actions': 'text7ef60018d7f5',
  'I’ve turned the app on for the right users': 'text3fc0e7a9c0c5',
  'JumpCloud Declare Redirect Endpoint, Save, and Copy Metadata URL': 'textd7c3b862b739',
  'JumpCloud SSO applications list': 'text7bffb6b49315',
  'JumpCloud SSO config with IdP Entity ID, SP Entity ID and ACS URL': 'text56fd83f9dc26',
  'JumpCloud User Attributes mapping': 'texte7cb57a73721',
  'JumpCloud admin → Access → SSO Applications': 'text1b247decbb75',
  'JumpCloud admin → Access → SSO Applications → your app → Identity Management':
    'textbdee13d828b2',
  'JumpCloud include group attribute set to groups': 'text9f46497fbf67',
  'JumpCloud only sends groups the application is BOUND to (User Groups tab). Bind each group you plan to map in Kortix; the name must match the connect-step claim.':
    'textfc4ff3e38b06',
  'JumpCloud provisions the members of the user groups BOUND to this app — binding a group both scopes who is pushed and syncs the group itself.':
    'texte620ec0b0d1f',
  'JumpCloud pushes changes as they happen (group binds, membership changes) — a quiet period just means nothing changed.':
    'textde4066927089',
  'JumpCloud pushes users and groups to Kortix from a "Custom Application" using its Identity Management (SCIM) tab. Provisioning needs the JumpCloud SSO entitlement.':
    'text2d9da88db71f',
  'JumpCloud sends only the groups BOUND to this application, on the "groups" attribute — bind (and map) the groups you want before they appear.':
    'textc1682b5136e2',
  'Kortix supports SCIM 2.0 Users + Groups, PATCH, and `attribute eq "value"` filters. Bulk operations are not supported.':
    'text7301076e877e',
  'Kortix → User access': 'text617ef6aeaa0d',
  'Kortix’s Entity ID IS the SP metadata endpoint, so importing it fills ACS + Audience for you. Pick "Manually Enter" instead and there is no "SP Metadata URL" field — you’d have to type the ACS URL and Entity ID by hand.':
    'texta8750f8dbc44',
  'Last name': 'text7b4888049459',
  'Manage claim': 'text6abe782495a0',
  'Manage claim panel showing the namespace and source attribute': 'text5aea242c938d',
  'Manage → Users and groups': 'text4b2fcfb4b248',
  'Map parameters': 'text7cd578cd0f3a',
  'Map the groups attribute': 'texta5b50db9091c',
  'Map user attributes': 'text08264211dd92',
  Match: 'text03c0e806becb',
  'Metadata URL': 'text5ead7fa05fdd',
  'Mint a token & connect provisioning': 'text1956371bd3d4',
  'Mint a token & connect Identity Management': 'text6718dff3a548',
  'Mint a token & connect provisioning in Entra': 'text51cbb7873b3d',
  'Mint a token & connect the SCIM connector': 'text44bbad128435',
  'Mint a token & create the SCIM Outbound connection': 'text9c84c29601d2',
  'Mint a token & enable SCIM on the Okta app': 'textfd1b12f0503c',
  'Mint a token & point your IdP at Kortix': 'text92833b623496',
  'Mint the bearer token your identity provider authenticates with — then paste it and the Tenant URL straight into your IdP below. Everything you need stays on this one page; no flipping back to copy a value.':
    'text4cb3866aa93e',
  'More Actions → SAML Metadata': 'textd02db30b123e',
  'Multi-value parameter': 'textbc298b920f14',
  Name: 'textdcd1d5223f73',
  'Name ID': 'textb30183ea54ee',
  'Name ID format': 'text3e6ec9535a11',
  'Name ID format and Application username settings': 'textd575819db004',
  'Name ID format: EMAIL. Name ID: Basic Information → Primary email.': 'text1627f835d6e1',
  'NameID: the user’s email (EmailAddress format). Also emit an email attribute.':
    'text32b8520a5f50',
  Namespace: 'textc4e4e7abda20',
  Next: 'text1ff57a29d7c9',
  'No hosted URL handy? Switch to "Manual configuration" and paste the XML from SSO → More Actions → SAML Metadata instead — it is the same metadata.':
    'textb205c515d0be',
  'No hosted URL? Switch to "Manual configuration" and paste the XML from "Export Metadata" instead — but the URL auto-refreshes when JumpCloud rotates the cert, so prefer it.':
    'textd37b08fa1bee',
  'No policy = a locked door: Cloudflare denies everyone until at least one Allow policy exists. This is the most common "SSO redirects but access is denied" cause.':
    'text93d6bb239aae',
  'OAuth Access Token': 'text09f5b7872743',
  'Okta admin console with the Applications section expanded': 'textbb3457786e8d',
  'Okta app Provisioning tab with the Configure API Integration panel': 'text5d8f1a868df2',
  'Okta pushes changes as they happen (assignments, profile updates, group pushes) — a quiet period just means nothing changed.':
    'textafb837ec251a',
  'Okta sends group NAMES (the Okta GroupName), exactly as they appear in the Okta admin console — map those names.':
    'texte76b8dc1a636',
  'Okta sends the matching groups by NAME — those names are what you map in Kortix. The attribute name (groups) is what Kortix reads as the group claim.':
    'text1b10c2cfc647',
  'On success the user lands in Kortix and appears under Members on the account’s Identity page.':
    'textee9f51217082',
  'On the "Attribute mapping" step, click "Add mapping" for each row: pick the Google Directory field on the LEFT, and type the App attribute name (primaryEmail / firstName / lastName) on the RIGHT. In the end it should look like this:':
    'textecff14af6cf4',
  'On the "Browse Microsoft Entra Gallery" page, click "Create your own application".':
    'texte0eeb4761e83',
  'On the "Configure SAML" step, locate the "Single sign-on URL" and "Audience URI (SP Entity ID)" fields. Copy the values below and paste them into their respective fields.':
    'textde8d23760b6d',
  'On the "Google Identity Provider details" step, click "Download metadata", paste the XML file’s contents below, then click "Continue" IN GOOGLE to open the "Service provider details" screen (the next step).':
    'text2477d724436e',
  'On the "Identity Management" tab itself (once Test Connection has succeeded), check "Enable management of User Groups and Group Membership in this application" so bound groups (and their members) are pushed to Kortix.':
    'text53a46e4cc509',
  'On the "Parameters" tab, set the "SCIM Username" parameter’s value to the user’s Email — that makes SCIM userName the email Kortix correlates on. Leave the default externalId mapping as-is.':
    'text7acdd33eff33',
  'On the "Provisioning" tab, tick "Enable provisioning". Then UNCHECK "Require admin approval before this action is performed" for Create, Update, and Delete — otherwise every change waits in a pending queue and nothing reaches Kortix until you approve it by hand.':
    'text8728456791ca',
  'On the "Service provider details" step, paste these two values.': 'textc1f0ae357feb',
  'On the Configuration tab, ENABLE the application, then copy the "IdP Metadata URL" and paste it below.':
    'text469d09327d17',
  'On the Configuration tab, paste Kortix’s values. Note OneLogin uses several fields for the ACS URL.':
    'text63e1d5a5403f',
  'On the Parameters tab, add a SAML parameter for each attribute and map it to its OneLogin value from the dropdown. Tick "Include in SAML assertion" on every one, or the value is never sent.':
    'textb89092d6036a',
  'On the Provisioning tab → To App → Edit.': 'textd7c4cbc403b9',
  'On the SSO tab, copy the "Issuer URL" (it is a live, hosted metadata endpoint) and paste it below — keep the "Dynamic configuration" option selected. Prefer this over pasting XML: the hosted URL auto-refreshes if OneLogin rotates the signing certificate.':
    'texte5fb560ba65a',
  'On the SSO tab, paste Kortix’s ACS URL and Entity ID into the two SP fields.':
    'text68332bc84407',
  'On the application settings page, select the "Assignments" tab. Click "Assign" and select "Assign to Groups" (or "Assign to People" for individual users).':
    'text50f3554f9cca',
  'On the app’s "Identity Management" tab, turn on SCIM and point it at the two values shown above.':
    'textcfd094933139',
  'On the app’s "Provisioning" tab, choose SCIM and Save. A configuration panel appears → "Configure API Integration" → tick "Enable API integration".':
    'text2204e7921e43',
  'On the app’s "Sign On" tab, in the "Metadata details" section, locate the "Metadata URL" and click "Copy". Paste it below to continue.':
    'text1c27f2b12cec',
  'On the app’s "User Groups" tab, tick the JumpCloud user group(s) whose members should be provisioned, then Save. Bind at least one group — with none bound, no users are pushed.':
    'text36fec9927cb1',
  'On the same page, locate the "Attributes & Claims" section and click the "Edit" icon in its top right corner.':
    'text06cff49d950a',
  'On the wizard\'s last step ("Help Okta Support understand how you configured this application"), select "This is an internal app that we have created" and click "Finish" — it\'s just Okta\'s own telemetry question, not a Kortix setting.':
    'textc81dda488e17',
  'OneLogin Applications list with the SAML connector app': 'texta4e5e14f93c8',
  'OneLogin Configuration tab with Audience, Recipient and ACS URL fields': 'text2fa3f7230583',
  'OneLogin SSO tab with the Issuer URL and the More Actions SAML Metadata download':
    'textea873f3351bc',
  'OneLogin admin → Applications → Add App': 'text50137ff5d7e9',
  'OneLogin admin → Applications → Applications': 'text0a98daa970ad',
  'OneLogin admin → Users': 'textba97f8006840',
  'OneLogin groups parameter with the multi-value flag enabled': 'text30d17a039700',
  'OneLogin mapping a parameter to its value with Include in SAML assertion': 'textbed65ccdcd2f',
  'OneLogin pushes changes as they happen once provisioning is enabled — a quiet period just means nothing changed (or actions are held in the approval queue).':
    'textc8b4cda7a1c8',
  'OneLogin pushes users and groups to Kortix with its "SCIM Provisioner with SAML" connector — a SEPARATE app from the SAML-only connector. Outbound provisioning is a paid OneLogin tier; the Provisioning tab only appears when your plan includes it.':
    'textd4e247cd9e30',
  'OneLogin sends the user’s Role names on the "groups" parameter — map those names in Kortix. The parameter MUST be flagged multi-value, or OneLogin collapses every role into one string.':
    'text721d4177c1ee',
  'Only assigned users are provisioned; users created directly in Kortix are not linked back to OneLogin.':
    'textc8ad7b65129f',
  'Only internal PingOne groups can be pushed; membership scope follows the rule’s User Filter and Populations.':
    'text66ebce029c63',
  'Open "Provisioning" in the left nav and click "Get started" (first time) or "Edit provisioning" (if already configured). Set "Provisioning Mode" to "Automatic".':
    'text8e44b0b44ff0',
  'Open the SAML connector app': 'textff53f5e63f80',
  'Open the SSO application': 'text99265c6ef78c',
  'Open the app → "Identity Management" tab. In its Configuration set "API Type" = "SCIM API" and "SCIM Version" = "SCIM 2.0".':
    'text8a0e45f72b69',
  'Open the app → "User Groups" tab → tick the group(s) whose members may sign in (create one under User Groups and add your test user first if you have none). Save.':
    'textdce7165865e9',
  'Open the app’s "Addons" tab — it sits in the tab strip at the top of the application page (Quickstart · Settings · Credentials · APIs · Organizations · Addons · Connections), NOT inside the Settings page — and toggle ON "SAML2 Web App". This opens the addon’s Settings modal.':
    'texte7249953afb9',
  'Open the same enterprise application you created for SAML SSO (Entra ID → Enterprise applications → your app).':
    'texte8b8e79d187c',
  'Open your SAML application': 'text349a89d57f58',
  'Open your application': 'text6857b7f48602',
  'Order matters: tick "Declare Redirect Endpoint" and Save BEFORE copying metadata — copying before Save yields metadata with the wrong binding or a missing certificate, and Kortix silently gets the wrong SSO endpoint.':
    'text187f9c2d0625',
  'Parameters → Include in SAML assertion': 'textb61483615d2a',
  'Parameters → groups': 'text3e583390b723',
  'Paste the Kortix Entity ID into "SP Entity ID" ONLY. Leave "IdP Entity ID" as the value JumpCloud pre-populates — that is JumpCloud’s own identifier and it flows into the exported metadata for you. Then check "Sign Assertion".':
    'text32d2efb69c25',
  'Paste the Tenant URL into "Base URL" and the secret into "Token Key" (auth is HTTP Header → Authorization: Bearer). Enter a FRESH test-user email that does NOT already exist in Kortix, click "Test Connection", then click "Activate" — do NOT click Save during the test-user step or you lose the configuration.':
    'textb460ebf34ddb',
  'Paste the Tenant URL into "SCIM Base URL", set "Users Resource" = /Users, "Groups Resource" = /Groups, "SCIM Version" = 2.0. Set "Authentication Method" = "OAuth 2 Bearer Token" and paste the secret into "OAuth Access Token". Click "Test connection", then Save.':
    'textbf2ddf28deeb',
  'PingOne Applications list': 'text376fe4769903',
  'PingOne Attribute Mapping with saml_subject, email, id, firstName, lastName': 'text1c35553b79b1',
  'PingOne Configuration tab with the IdP Metadata URL': 'textcd4c984492ce',
  'PingOne SAML Configuration with the Import from URL option': 'text1996ba994792',
  'PingOne derives the ACS URL and Entity ID from Kortix’s SP metadata — you don’t type them separately. On the app’s SAML Configuration page, choose "Import from URL" (NOT the default "Manually Enter"), paste Kortix’s Identifier (Entity ID) into the metadata URL field, and click Import — PingOne auto-fills the ACS URLs and Entity ID.':
    'textb2932a4b2ce3',
  'PingOne groups attribute mapped to Group Names': 'text7936058bc9ef',
  'PingOne pushes users and groups to Kortix through a generic "SCIM Outbound" connection under Integrations → Provisioning. Use the modern PingOne cloud console (Workforce) — the legacy "PingOne for Enterprise" product does not have this.':
    'text0b99f41d2759',
  'PingOne runs an initial full sync when the rule goes Active, then pushes incremental changes as your directory changes.':
    'textc0472b8d5a10',
  'PingOne sends group NAMES when you map a "groups" attribute to "Group Names" — groups are OFF by default, add the mapping explicitly.':
    'text68f904811e19',
  'PingOne → Connections → Applications': 'texte5431f3fcc1a',
  'PingOne → Integrations → Provisioning → New Connection': 'text2867d17a84dd',
  'PingOne → Integrations → Provisioning → Rules': 'text6f486b482ccd',
  'Prefer to paste XML? Open the SSO endpoint URL with /saml-metadata appended in a browser and paste the returned EntityDescriptor XML into the Manual option above.':
    'text40ca33269747',
  'Primary email': 'textd535ab1a7938',
  'Profile attribute statements': 'text4e4b9ad5e039',
  'Profile attribute statements filled with email, firstName, and lastName': 'text1877b4713d40',
  Protocol: 'textcf0883343f4a',
  'Provide App Metadata': 'text524a79b18f1b',
  Provision: 'text41112adcd22c',
  'Provision on demand': 'text1785635529d1',
  Provisioning: 'textc2b1b8e2e039',
  'Provisioning Status': 'text7fdf5bcb19a8',
  'Provisioning To App settings with the three sync-action checkboxes': 'textd1c7fb162898',
  'Provisioning tab → tick "Enable provisioning" and UNCHECK "Require admin approval" for Create/Update/Delete — otherwise every change waits in the pending queue.':
    'text441ae1beeaa5',
  'Provisioning → "Start provisioning" (Provisioning Status: On). The scheduled cycle then runs every ~40 minutes on its own; "Provision on demand" pushes one user instantly.':
    'text119e32ef5780',
  'Provisioning → "To App" → Edit → enable Create / Update / Deactivate Users → Save. Assignments and pushed groups then sync automatically as they change.':
    'textfdb55672b8c6',
  'Provisioning → Mappings → Provision Microsoft Entra ID Users': 'text5261579cf365',
  'Provisioning → Overview': 'texte7f95b0311f4',
  'Provisioning → Overview → Current cycle': 'text9436d4696192',
  'Provisioning → To App': 'text513bc5f876b0',
  'Provisioning → Workflow': 'text33e9b6a7ed81',
  'Push Groups': 'text717c4a937fe5',
  'Push Groups tab with Find groups by name and Push Immediately option': 'textfa867b6041b8',
  'Push Groups tab → "+ Push Groups" → "Find groups by name" → search and select the group → check "Push Immediately" → "Save".':
    'text124bd4ab7857',
  'Push Immediately': 'textf9d46c1722ea',
  'Push groups: on the app’s "Provisioning" tab, under "Entitlements", click "Refresh" so Kortix’s groups load. Then on the "Rules" tab add a Rule — a condition (e.g. member of a OneLogin Role) with the action "Set Groups in Kortix" → the group.':
    'textb20e428d9c27',
  'Push groups: still in the rule’s "Directory" tab, click the pencil next to "Groups" → "Search Group Name" → pick the internal groups → review under "Selected Groups" → Save. PingOne pushes those groups and their memberships to /Groups.':
    'texte53bfff585aa',
  'Pushed groups appear under Groups — grant them project roles to confer access.':
    'text9c5c537db3fe',
  'Pushed groups are created in Kortix under their displayName.': 'textbf8d3ae91a75',
  'Put the ACS URL in both "Recipient" and "ACS (Consumer) URL". The "ACS (Consumer) URL Validator" is a REGEX field, not a plain URL: take the ACS URL above, escape every dot (. becomes \\.), and anchor it with ^ … $. For example, if the ACS URL is https://api.kortix.com/auth/v1/sso/saml/acs, paste ^https:\\/\\/api\\.kortix\\.com\\/auth\\/v1\\/sso\\/saml\\/acs$ — a pattern that doesn’t match the exact ACS URL makes the sign-in fail with no clear error.':
    'textd90f99f1be57',
  Recipient: 'text51fac985e953',
  'Recipient (ACS URL)': 'text5fd0f0afed3f',
  'Register Kortix in your IdP': 'textdc5f0f8236de',
  'Removed from the Entra group → the mapped Kortix access is gone on next sign-in.':
    'texta01e54c04671',
  'Reply URL (Assertion Consumer Service URL)': 'textd07d886c79ea',
  'Require admin approval — Create': 'text139241655203',
  'Require admin approval — Update / Delete': 'textf7dc7405b0fc',
  'Return to the application (Applications → your app) and make sure the "Sign On" tab is selected.':
    'text27f8489b0380',
  SAML: 'text568b0ff92720',
  'SAML Certificates section with the App Federation Metadata Url': 'text76768949196e',
  'SAML Metadata URL': 'textf61cb753e9f1',
  'SAML attribute statements': 'textc871dedbbe7a',
  'SAML brokered through Cloudflare Zero Trust': 'text7f5972375548',
  'SAML via a JumpCloud SSO application': 'textef3c99fe021e',
  'SAML via a OneLogin custom connector app': 'textefed7f3bda99',
  'SAML via a PingOne application': 'text71f30b5dbccf',
  'SAML via a custom Google Workspace app': 'textde3bf9cc102d',
  'SAML via an Entra enterprise application': 'text5b870e1262d3',
  'SAML via an Okta app integration': 'textf13e18e1c246',
  'SAML via the Auth0 SAML2 Web App addon': 'textf800bf7b9497',
  'SAML2 Web App': 'textc1dc1081d53b',
  'SAML2 Web App → Settings': 'text9a7b1baef5f5',
  'SCIM Base URL': 'text7af959bda32d',
  'SCIM Bearer Token': 'text9f3d1b008e46',
  'SCIM Outbound → Configuration': 'text3e729afb3dcc',
  'SCIM Version': 'textab936b802fa6',
  'SCIM connector base URL': 'text726ca2677b52',
  'SP Entity ID': 'text1994b6869b97',
  SSO: 'text5ba3ac9fc8e8',
  'SSO configuration': 'texta025e07fb9e1',
  'SSO endpoint': 'text7d4e3b0e3543',
  SaaS: 'text34544f40422b',
  'SaaS app → Configuration': 'textebfeebd13e38',
  'SaaS app → Overview → SAML Metadata endpoint': 'textb2efab3da232',
  Save: 'text1509f561f241',
  Scope: 'textb073f6c68ef8',
  'Scope is group-based: membership of the bound groups defines who is provisioned. Unbinding a group deprovisions its members.':
    'textefe594df4c9c',
  'Scope users and select groups': 'text9e46005ff736',
  Search: 'text49c266baaaa7',
  'Secret Token': 'textcf2ec914e0b8',
  'Select SAML as the single sign-on method': 'text9776aace7938',
  'Selecting users and groups to assign to the application': 'text9304e38e3397',
  'Service provider details': 'text4b6617d27a7f',
  'Service provider details step with ACS URL and Entity ID fields': 'text67a17137d0e8',
  'Service status': 'textcce5eda33f91',
  'Set "Name ID format" to Email — Kortix correlates accounts by email address.':
    'textdc26b6a994c2',
  'Set identity provider metadata': 'text8bbecc2acd82',
  'Set the matching attribute so "userName" is the user’s email — that is how Kortix correlates a SCIM user to an account.':
    'textbdeb4b447636',
  'Set the rule to Active/enabled — PingOne then runs an initial full sync and incremental syncs on directory changes.':
    'textb5a7e2126214',
  'Set up Single Sign-On with SAML → Attributes & Claims': 'textbe2fe9fb8f0d',
  'Set up Single Sign-On with SAML → Basic SAML Configuration': 'text8041e959f5fd',
  'Set up Single Sign-On with SAML → SAML Certificates': 'texte7aebc082836',
  'Set userName to the email Kortix correlates on: open the "Attribute Mapping" section (separate from the auth screen), in the "PingOne Directory" column expand "Username" and select "Email Address". Then in the connection’s preferences/actions set "User Identifier" = userName and "User Filter Expression" = `userName eq "%s"`. Getting this wrong is the #1 PingOne failure — it defaults to the internal username, not the email.':
    'text265e52a33b53',
  'Settings JSON': 'text35e1e7990d8b',
  'Show legacy configuration': 'text8ef21fbafcfa',
  'Show legacy configuration expanded with profile and group attribute statements':
    'text5f8d6590fdc6',
  'Sign On tab with the Metadata URL and Copy button': 'text91546e704c9e',
  'Sign On → Legacy configuration': 'text67a35d788f4d',
  'Sign in to the Microsoft Entra admin center (entra.microsoft.com) as an admin of your tenant.':
    'texted2d94ab1136',
  'Sign in to the Okta admin console.': 'textf95580852de0',
  'Sign on URL': 'text8a0b88c0ea43',
  'Sign-in method': 'text2bb30a7e4603',
  'Single sign-on': 'text3bc44ac28dcd',
  'Single sign-on URL': 'text1e237ea61e62',
  'Single sign-on → Attributes & Claims': 'textbf20a711b1b5',
  'Single sign-on → SAML Certificates': 'text1867a2ddd453',
  'Single sign-on → Select a single sign-on method': 'text89ff59fd8967',
  'Single sign-on → section 3 "SAML Certificates" → App Federation Metadata Url':
    'text5570cd1f7f25',
  'Source attribute': 'text20f25bdb24b4',
  'Source attribute: "Cloud-only group display names" for readable names.': 'textb3742c18c364',
  'Start provisioning': 'texte3abcd09412c',
  'Still in "Attributes & Claims", click "Add a group claim".': 'text469ad0b25e29',
  'Still in Attribute Mapping, add a "groups" attribute mapped to PingOne’s "Group Names" — this sends the names of the user’s groups.':
    'text2973e89393cb',
  'Still on the attribute mapping step, scroll to "Group membership (optional)", click "Add Google groups", select the groups to send, and set the "App attribute" to groups. Click "Finish".':
    'textaa3ec85f955d',
  'Take the "SSO endpoint" Cloudflare shows for the app and append /saml-metadata to it — that URL serves the SAML metadata XML.':
    'text8c92dea1569a',
  'Tenant URL': 'text097fe0b10cc3',
  'Test API Credentials': 'text9443f43e1374',
  'Test Connection': 'textc02977b07ec9',
  'Test Connection passes with a fresh test email, and the app’s Identity Management shows Activated.':
    'text636ad4e91c30',
  'Test Connection passes, the Mappings list shows userName → user.userprincipalname, at least one user/group is assigned, and the Provisioning overview shows "On".':
    'text48ef1ecb3d25',
  'Test connection': 'text5bcf311b19d8',
  'Test connection passes, the connection toggle is enabled (blue), and the Username attribute maps to Email Address with a `userName eq "%s"` filter.':
    'text9994720f645e',
  'Test single sign-on': 'text2bf4ee86ea70',
  'The "Create SAML Integration" wizard opens. On the "General Settings" step, enter an appropriate app name, such as "Kortix" — optionally upload an app logo. Click "Next".':
    'text02c2fe3ed248',
  'The "Google Identity Provider details" step → Download metadata (GoogleIDPMetadata.xml). Google does not host a metadata URL.':
    'textc436c2a32b85',
  'The "Set up Single Sign-On with SAML" page opens. Locate the "Basic SAML Configuration" section and click the "Edit" icon in its top right corner.':
    'text8cae0a15ed1e',
  'The Configuration / Parameters / SSO tabs only appear AFTER that first Save — save the app once, then reopen it to configure.':
    'text7ddc2f43eb64',
  'The JumpCloud user groups you bind to the app are created in Kortix under their JumpCloud names.':
    'textbd82a26d7bf4',
  'The SSO app → Copy Metadata URL (a hosted link) — or Export Metadata for the same XML.':
    'textca79bc98e751',
  'The application’s Settings → Advanced Settings → Endpoints → SAML Metadata URL (hosted).':
    'text32d1a43a026b',
  'The app’s Configuration tab → IdP Metadata URL (a hosted link).': 'textb4a68ca59392',
  'The app’s SSO tab → Issuer URL (a hosted metadata link) — or download the same XML via More Actions → SAML Metadata.':
    'textcb1e741d2510',
  'The attribute name (groups) must match Kortix’s group claim, which is prefilled at the connect step. Cloudflare passes through whatever group NAMES the upstream IdP sends.':
    'textf29ad8b8092c',
  'The federation metadata you captured earlier is prefilled below. Kortix registers your IdP and routes sign-ins for your email domain through it.':
    'textbf692d2cef5a',
  'The internal PingOne groups you select on the provisioning rule are created in Kortix under their PingOne names.':
    'text19e9b5ae9295',
  'The member/group counts below tick up as JumpCloud pushes the bound groups and their members.':
    'text728545349685',
  'The member/group counts below tick up once the rule is Active and PingOne runs its first sync.':
    'textfed6011cdb1e',
  'The member/group counts below tick up, and OneLogin’s Provisioning log shows each user/group actioned (not left "pending").':
    'text28428b26bd73',
  'The member/group counts below tick up, and in Entra’s Provisioning log every stage (Import, Scope, Match, Perform action) shows Success.':
    'text02d06a92b6a6',
  'The member/group counts below tick up, and your IdP’s provisioning log shows the sync succeeded.':
    'text76e6f296f208',
  'The parameter name (groups) must match Kortix’s group claim, prefilled at connect.':
    'textab82003261fe',
  'The saml_subject / Name ID defaults to a GUID — set it to Email Address (format urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress) so the subject matches the email Kortix keys on, belt-and-braces with the email attribute.':
    'text619fdd853ca0',
  'The test user must be allowed by your Access policy (Cloudflare has no per-user app assignment) — a denied sign-in almost always means the policy is missing or too narrow.':
    'text983ebcce2a1d',
  'The test user must be allowed to reach the app — otherwise the IdP rejects the sign-in with a “not assigned” error.':
    'text847e3d7b2190',
  'The test user shows up under Members on the Identity page — that’s a confirmed round-trip.':
    'textd355044d5f9b',
  'This guide covers the DOWNSTREAM half (Cloudflare → Kortix). The upstream half (your IdP → Cloudflare) follows Cloudflare’s own documentation for your provider.':
    'textf44f2ebac561',
  'Tick "Declare Redirect Endpoint" FIRST (it changes the generated metadata), then click "Activate" / "Save" — that step generates the app’s signing certificate. Only AFTER saving, copy the "Metadata URL" and paste it below (keep "Dynamic configuration" selected).':
    'text2334606a7abf',
  'To deactivate from Entra: set the user’s "Block sign in" (Account enabled = off), then provision them again — or run "Provision on demand" to apply it immediately.':
    'textac121e59d684',
  'Token Key': 'text728004c3b617',
  'Turn on the sync actions': 'textaf5dbe54aa9c',
  'Turn the app on': 'textf2c143f1de76',
  'Under "API Connection": paste the Tenant URL into "SCIM Base URL" and the secret into "SCIM Bearer Token", then click the "Enable" button (save the app first if prompted). OneLogin validates the endpoint and "API Status" then shows a green "Enabled" — that field is a read-only indicator, not a control you set.':
    'text8ce429d50e7c',
  'Under "Admin Credentials", paste the two values shown above: "Tenant URL" and "Secret Token". Click "Test Connection" — a green "Testing the connection was successful" banner is success. Click "Save".':
    'text76ee9b4de20b',
  'Under "Export Attribute Mapping", confirm the user’s email flows into SCIM "userName" — JumpCloud sets this by default, so there’s usually nothing to change. Kortix correlates on that email.':
    'textea66cdc4376c',
  'Under "Group Attributes", check "include group attribute" and set the attribute name to "groups".':
    'textff254d2f2db2',
  'Under "User Attributes", add each Service-Provider-Attribute-Name → JumpCloud-Attribute-Name pair. The left column is the SAML claim Kortix receives; the right is the JumpCloud user field.':
    'textd0a51a423a4c',
  'Unique User Identifier': 'textd549bdd8591d',
  'Unique identifier field for users': 'text5a052671ec75',
  'Update User Attributes': 'text3a37d30d808f',
  'Use the same Okta app integration you created for SAML SSO.': 'text9f58ef2bda65',
  'User Attributes': 'text9e4e9bf26067',
  'User attribute mapping': 'textd1404ef87a5e',
  Users: 'text6b0cc904d081',
  'Users Resource': 'text7e38b9391913',
  'Users and groups': 'textf3fcc2e819e8',
  'Users and groups in the Manage section': 'texta5d2a0afcd9c',
  Value: 'text8e37953d23da',
  'Verify provisioning': 'text465887292bcb',
  "What's the name of your app?": 'textdb1e359790c5',
  'Whatever attributes Kortix needs (email, first/last name, and groups) must survive the upstream hop — Cloudflare forwards them on.':
    'text1ad818754c47',
  'When group sync maps OneLogin Roles, those same Roles are what gate app access — so assigning via a Role does double duty (access + the "groups" value).':
    'text2aebea9f007a',
  'When you finish the "Add an application" form, Cloudflare shows the app’s SSO endpoint, Access Entity ID, and public key. Copy the "SSO endpoint" value and append /saml-metadata to it — that URL serves the metadata XML. Paste the full URL below to continue.':
    'text68c93b1922a4',
  'Which groups associated with the user should be returned in the claim?': 'textefba6ec875c0',
  'Which groups: "Groups assigned to the application" (keeps the claim small).': 'text92578777350a',
  'Without the multi-value flag OneLogin collapses all roles into one delimited string — group sync then sees a single junk "group". Always enable it.':
    'textaf69effdd900',
  'You can reuse the same Custom Application you made for SAML SSO — SCIM lives on its "Identity Management" tab.':
    'text2a728809f134',
  'You configure everything in Cloudflare’s single “Add an application” wizard (the Configuration / Authentication / Policies / Overview tabs only appear when you EDIT the app later). First, paste Kortix’s service-provider values into Cloudflare’s fields.':
    'text5e835fd4ee59',
  'You will add a new SCIM connector app below; the SAML Custom Connector used for SSO does not push users.':
    'text4c36403a4549',
  'Your IdP’s SAML metadata export (URL or XML)': 'textb2a1a9b22a36',
  'Your PingOne environment needs the Provisioning service enabled (standard on PingOne cloud, no separate SCIM SKU).':
    'text47f276fa1983',
  'Your app → Addons': 'text7966b3c1d0c0',
  'Your app → Assignments': 'text4c02a39da36f',
  'Your app → Assignments / Push Groups': 'text6afba7b18fff',
  'Your app → Attribute Mapping': 'texta72ff134c021',
  'Your app → Configuration': 'text95aa6dcb7c78',
  'Your app → Configuration → IdP Metadata URL': 'text4cd1b93918a9',
  'Your app → Configuration → SAML': 'textf084ea5cc3bf',
  'Your app → General → App Settings': 'text3502b55692e4',
  'Your app → Identity Management (enable the checkbox) + User Groups tab': 'text881ebc240369',
  'Your app → Parameters': 'texta8b4ffedb6a6',
  'Your app → Provisioning → To App': 'textdf2567a8cc4f',
  'Your app → SSO': 'text6d47a6d00578',
  'Your app → SSO → Copy Metadata URL': 'textcfeafa33e54b',
  'Your app → SSO → Group Attributes': 'text412c9a761b4a',
  'Your app → SSO → Issuer URL': 'texta161387fb339',
  'Your app → SSO → User Attributes': 'textdd0b6a747c8e',
  'Your app → Settings → Advanced Settings → Endpoints': 'textc27cafdc51f8',
  'Your app → Sign On': 'textd96e9599b178',
  'Your app → Sign On → Metadata details': 'text9839dbb8a3a8',
  'Your app → Single sign-on → SAML': 'text08b16c6c10bd',
  'Your app → User Groups': 'text4386df03b212',
  'Your app → User access': 'texte86c155fb15a',
  'Your app → Users / Rules': 'text5b496b6a8f8d',
  'Your app → Users and groups': 'text28d1010d7528',
  'Your application': 'text4a198896ec9c',
  'Zero Trust → Access → Applications → Add an application': 'text71b53d04ac61',
  'attribute name': 'textcdbea4c4728c',
  'audience (put in the Settings JSON)': 'textefb5e15a7fdd',
  email: 'text82244417f956',
  emailaddress: 'text2a9a3df163eb',
  firstName: 'text9cf22fd0154c',
  givenname: 'text128a07bfe2df',
  groups: 'text4ed379d418bb',
  id: 'texta56145270ce6',
  'include group attribute': 'text746c37cf5aba',
  lastName: 'text18c9e5d44e37',
  objectId: 'text1611b2d21d9c',
  'saml_subject (Name ID)': 'text7ae2e4d8b3fe',
  surname: 'text655c32fb8455',
  userName: 'text23ac944be61d',
};
