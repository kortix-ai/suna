// Generated from the security-selfhost user-visible UI catalog.
export const SECURITY_SELFHOST_TRANSLATION_KEYS: Readonly<Record<string, string>> = {
  '"May the agent send email" is not a guardrail. Conditions match the arguments, so the rule can be "only to these addresses". An argument that cannot be evaluated fails closed.':
    'text5e2ce6656b32',
  '/enterprise': 'text28346646cd67',
  '2 vCPU / 4 GB floor, 4 vCPU / 16 GB for real use': 'text66dee8fd0152',
  '3,000+ apps in a click, plus MCP, OpenAPI, GraphQL and raw HTTP. The third-party credential is held and resolved server-side; the machine holds one scoped Kortix token and calls through it. The same rule covers Kortix’s own provider keys, which no sandbox is allowed to hold.':
    'text1c81f8a26f00',
  'A change request is a diff. An agent rewriting its own prompt is reviewed the same way a code change is — because it is one. A change request whose manifest does not validate cannot merge at all.':
    'textd4edcc30c8f6',
  'A clone of the project repo on a branch named after the session': 'textb12138e47064',
  'A domain you point at the box, or a Cloudflare tunnel for evaluation. Sessions run on a remote sandbox and have to call back, so this is the first real decision.':
    'text022755798da5',
  'A fresh RSA keypair for SAML, so SSO has a key the day you turn it on': 'textd68363e3fe3f',
  'A key is granted to a session, not pasted into a prompt.': 'text9181ff5dca36',
  'A laptop': 'text5c65777abb06',
  'A laptop, a VPS, or your own network.': 'texteccba86b787c',
  'A person or a group can be narrowed to named agents and skills inside a project: marketing may use this agent and that skill, and nothing else. Anything you leave unscoped stays project-wide, so narrowing is something you opt into rather than something you have to undo.':
    'text3c86ce6ea087',
  'A person reads the diff': 'texta6e5f1bdfb1f',
  'A record for the domain and for api.<domain>': 'text6251a79326de',
  'A runtime secret a session is granted is a real environment value inside that session, because that is how a tool uses it. We would rather say so than tell you it is invisible. The controls that matter are the two gates above, and the fact that the machine is destroyed with it.':
    'text36f80c38222d',
  'A self-hosted instance has no managed model lineup and does not want one. You connect the providers you already pay for, and every model call routes through the gateway running on your own box.':
    'text45ba74fd89a9',
  'A self-hosted instance runs its own gateway for its own model routing. It never sees or routes to Kortix credentials, and there is no platform fee on a self-hosted account.':
    'text2c9254d4dcde',
  'A service account is a first-class machine identity the account owns, not a human token wearing a hat. Policies attach to it directly, and a request it makes is evaluated purely against its own policies — it never inherits the reach of whoever created it.':
    'text93cf8ed6d1fd',
  'A session gets exactly one machine, enforced in the database rather than by convention. Sessions never share a filesystem with each other, and the machine has a bounded lifetime rather than living forever.':
    'text2f689fee14ca',
  'A session is not a tab in a shared runtime. It is a machine of its own, and the database will not let two sessions have the same one. Separating two of your own sessions is the same mechanism as separating two different customers.':
    'text77413322bcd5',
  "A session's chamber: what is {inside}, and what {outside}.": 'text8552ade1b621',
  'A single-tenant deployment inside your own network. Air-gapped and other isolated topologies are scoped with us rather than self-served.':
    'text0b930139d03b',
  'A tool needs a real credential to do real work, so the honest question is not whether the machine ever holds one. It is which machine holds which key, who decided that, and what never gets in at all.':
    'textf680871347c5',
  'A VPS or cloud VM': 'text756d9ae136b6',
  account: 'text9af211329b2f',
  'Account audit log': 'textc82a704b501b',
  'Accounts, roles, policies, triggers, channels and the audit record': 'text7546560467b7',
  Acknowledgement: 'textb0eafdef30da',
  Admin: 'textc1c224b03cd9',
  'Admin-only by default. People still join by invite or SSO either way.': 'text0084d5dc5abc',
  'AES-256-GCM, key per project': 'text7b1eb4d58456',
  'Agent sandboxes, which run on the provider you configure': 'text1a42d28bc87a',
  'Agreed with you, 90 days by default': 'texte3da85f3f963',
  'always_run, require_approval, block. A rule matches a glob over fully-qualified tool paths, so one line can cover a single call or a whole connector.':
    'textdc0badfb53b1',
  'An admin email': 'textda1aa627c64b',
  'An agent can write as much as it likes on its own branch. Landing that work on main is a separate capability it does not have unless you hand it over deliberately — and handing it over is itself a change someone has to approve.':
    'text647f2baf6191',
  'An agent declares in kortix.yaml which secrets it may ever be given. A session receives the intersection of that grant and the role of the person who started it — so an agent can never reach past its own declaration, or past the human behind it.':
    'text4f0fb30e3bee',
  'An agent is a principal, not a loophole.': 'textbc346bfb5269',
  'An agent that can install anything, call anything and write anywhere is only safe if the walls are real. In Kortix they sit below the agent, in the platform, where a prompt cannot talk its way past them.':
    'textb9c1352c8c67',
  'Another session — same project, same team, or another customer': 'text0686a22fbf7d',
  'Anthropic, OpenAI, Google, Groq, xAI, DeepSeek, Mistral, Bedrock and OpenRouter, or the ChatGPT and Copilot subscription you already hold.':
    'text60a7b3de1d65',
  'Any provider. Your keys. Your bill.': 'text7e9fee157731',
  'Anything you can reach': 'textdf8e32d18dbd',
  'Approval is not a setting buried in an admin panel. It is a block in kortix.yaml, versioned with everything else, that says which tool calls run, which stop for a person, and which are refused outright.':
    'textc73d5a471c50',
  Audit: 'textbb6aea287396',
  'Automatic TLS. Rendered only when you set a domain': 'text870770429ab2',
  'Available on Enterprise, and on a self-hosted instance with an Enterprise licence. The built-in roles above are free on every plan.':
    'text7ea4733fb624',
  'Baseline account membership.': 'textb90eab55d0d5',
  'bring the stack up': 'text0e8cb88f5b30',
  'Bring us your security review.': 'text4d91ca15b501',
  'Built to survive a security review.': 'text231d895f30dd',
  'Built-in roles — on every plan': 'texteacdf25c58f8',
  caddy: 'textd6e0ff2b7a53',
  Certified: 'textc9996efd134f',
  'Change request, default-deny merge': 'textedca37f6aca7',
  channel: 'text69e36568cd8b',
  'choose which Kortix you are talking to': 'text893dc256bfc8',
  cloudflared: 'textfc8932c70118',
  'Configuration is files. Who changed which agent, which skill and which policy, and who approved it, is git history you already know how to read.':
    'text5acfbdbae44a',
  'connect a provider': 'text2f77dafd3fcc',
  'Connector credentials never enter the machine': 'textd87cb0774bec',
  'Connector credentials, which are resolved server-side': 'text8564edf2cd1f',
  'Connectors, and the update window': 'texte03abcb2b624',
  Control: 'text32d7e8208247',
  'Control-plane routing': 'text4cd112697d33',
  'Coordinated disclosure': 'textc493ebf742bd',
  Credentials: 'textd48a617c7da5',
  'Custom roles': 'textc703c7f9cbe6',
  'data plane': 'text7225a08be0c6',
  'Daytona, Platinum, or E2B. This is the one credential the stack genuinely cannot start without.':
    'textfe1e8536b04d',
  'Decide what needs a human before it happens.': 'text77ad70aefdce',
  'default_mode: risk makes reads run and sends writes and destructive calls to a person. A project with no policy block keeps the permissive legacy default, so set this explicitly.':
    'text221bf49bd2bb',
  Delivered: 'text906115657390',
  'Deployment & posture': 'texte030ac604b81',
  'Directory sync over /scim/v2, with tokens you mint and revoke. Built against Okta and Microsoft Entra.':
    'text65c8f24daa54',
  'Disposable by design': 'textdd6abe6fa86c',
  DNS: 'text020965a2f08f',
  'Docker Engine with the Compose plugin': 'text208037ac5573',
  'Each call an agent makes through a connector is a row: the action, the actor, the session, the risk class, whether it ran, was denied, or waited for a person, and who resolved it. Arguments are stored as a preview built by subtraction, so a credential cannot end up in the record.':
    'text500b4d333c4e',
  'edge — only what you chose': 'text97cf9dbf46ed',
  'Encrypted per project': 'text8de993d52a11',
  'Encrypted with AES-256-GCM under a key derived per project.': 'text0c8a43b9f730',
  Enterprise: 'text3fbe5ed156f1',
  'Evaluation, through a Cloudflare tunnel with no domain. The tunnel URL changes on every restart, so use it to try the product, not to run on it.':
    'text1bf917debaf4',
  'Every account action and every agent action is captured on every plan. The plan decides who may read, export, or stream that record — not whether it exists.':
    'textaca2f2064afe',
  'Every edit lands on the branch cut for that session. Nothing the agent does is visible to any other session, or to main.':
    'textf3b80d5fea1d',
  'Every gated call is approved on its own, with its arguments in front of you. There is no session-wide grant a later call with different arguments can hide behind — that shortcut was removed at the enforcement point, not just from the UI.':
    'textc11ead9d95f2',
  'Every gated tool call': 'text328130e3456a',
  'Every host port, reassigned automatically if one is already taken': 'text469bcc02c9f9',
  'Every internal URL the services use to find each other': 'text8545f075422b',
  'Every project repo and every secret the platform holds': 'textf8ef2de56f6b',
  'Everything the CLI generates is rotatable later with kortix self-host env rotate, and every value is visible with kortix self-host env ls, masked unless you ask for --show.':
    'textbebd0ee2eb17',
  'Export it or stream it': 'textce3a4968d879',
  'File storage, as a second directory next to it': 'textab0c820f8e1b',
  'Files, on a second directory': 'text8ffc985736b1',
  'First run': 'text4f35f7ed49ec',
  'Found something? Tell us privately.': 'textc181324d303e',
  frontend: 'text1cf387c012cd',
  'Full account control.': 'text51f5cf72f382',
  'Full project control, including members and delete.': 'textf58830babafb',
  'Gate the target, not just the tool': 'texte161fc2a83d8',
  GDPR: 'text803ac20b0345',
  'GitHub and your model key are not asked here on purpose. Both are set in the dashboard after the stack is up — GitHub at Settings → Git, the model key in the model picker.':
    'text2b112b05602c',
  'Grant to a group once instead of to twenty people twenty times.': 'textd2705348bbbb',
  Granted: 'text62026a42b239',
  'Grants platform admin, so you can configure GitHub and the rest in the dashboard. Optional, and you can set it later.':
    'text817f3bbaa974',
  group: 'textad936fcbed63',
  Groups: 'text39bbb719fa2b',
  'How this instance is reachable': 'text51aedaa8c251',
  'How work lands': 'text861edb55ee1d',
  'Identity & permissions': 'textca85e5c12d77',
  'In progress': 'textc1f88e9d6c41',
  Inbound: 'textd17a5bdde70e',
  'inside one session': 'texta5f5a7bb98a3',
  Install: 'text569ca49f4aaf',
  Isolation: 'text45c4fc064e52',
  'It commits and opens a change request': 'text28904e587358',
  'It is the same Compose project everywhere. What changes is where you point the domain and how much you give it.':
    'text6c94c3a6a6fa',
  'It keeps itself current': 'text51b143371424',
  'Its own sandbox, with its own filesystem and its own lifetime': 'text58f084456f75',
  kortix: 'text388f7968512c',
  'Kortix Cloud': 'text493bdb7154e4',
  'kortix self-host start': 'textdbef6cc84fef',
  'kortix self-host start registers the selfhost host for you and makes it active.':
    'text8ea44187f958',
  'kortix-api': 'text53b816218aba',
  'kortix-migrate': 'text763fafcec9c0',
  'kortix-updater': 'text52b1035fcd14',
  'kortix.yaml': 'text1965f383021e',
  'Kortix’s own upstream provider keys, which no sandbox may hold': 'text9fac860db4d4',
  'llm-gateway': 'text1a89c40bda2b',
  Machine: 'text8f1cc42d7c1c',
  'Manage members, groups, roles and tokens.': 'text186c10caa2d2',
  Manager: 'text8b2085f74dfa',
  member: 'texte31ab643c44f',
  Member: 'text7c968fb71f50',
  'Membership, roles, policies, tokens, groups and IAM changes are recorded as they happen, on every plan.':
    'text3add1ecd9b97',
  'Merge is a capability of its own, refused to every agent unless an admin grants it. That grant lives in kortix.yaml — so an agent cannot widen its own reach without a change request someone else approves.':
    'text7ecd596d8c70',
  'Merging is default-deny': 'text829e67c6a623',
  'microVM where you ask for it': 'textb3960c7e6888',
  Models: 'textd17d2d78d76e',
  'Most AI tools give the agent whatever the person who started it can reach. Kortix does not. An agent identity carries its own policies, evaluated on their own, so it cannot inherit its way up to something you never granted it.':
    'text1aeb8993945b',
  'Need it inside your own network, with SSO and a licence? Talk to us.': 'text0eae7ee74fc9',
  'never crosses in': 'text818da9a35cdc',
  'Nightly pull, migrate, then swap': 'text7aef9898f8f9',
  'Nightly, or pin a version': 'textd28d2fa96eaf',
  'No blanket "allow always"': 'textefa5b0c03255',
  'No metering in the way': 'textc89bd3fdc54a',
  'Not a community edition.': 'texte3bbf2902a7f',
  'not on your box': 'textaa57cad004f0',
  'Nothing is shared, because nothing is shared.': 'text9045e34e96f2',
  'On Kortix’s own Platinum compute a sandbox is a Cloud Hypervisor microVM. Daytona and E2B are also supported. The provider is a deployment choice, and we will tell you which one you are on rather than blur them together.':
    'text8368ff24d89c',
  'on your box': 'text425aa668a9e4',
  'One branch per session': 'textb0f2f6dd1e38',
  'One Compose project, no hidden pieces.': 'text2a2728fd9252',
  'One Docker Compose project': 'textc28e1cbeedd6',
  'One Docker Compose stack on your box, from the same images the managed cloud runs. Your database and your files sit on disk you control.':
    'textf17e37545b39',
  'One Docker Compose stack, built from the same images the managed cloud runs. Your database, your files, your repos and your policies sit on disk you control. It is open source, so what you are running is code you can read.':
    'textfbdfd536fa56',
  'One honest exception': 'text7b2aba63cf85',
  'One sandbox per session': 'texta8c9aab244af',
  'One sandbox per session · Connector keys never enter it · Nothing merges itself':
    'texte368fa0c5722',
  'One-shot database migration on every roll': 'text178880c99bfa',
  'Only the secrets that session is granted, placed there at boot': 'textbf38f30d64e1',
  'Opening a change request and merging it are different powers.': 'text74d1f5c328ca',
  Operated: 'text599f5c523ef2',
  'Override for one command instead of switching: pass --host selfhost.': 'text6d8788a320dc',
  Owner: 'text4b1b8aa3608a',
  Parity: 'text717ef1d1505c',
  'Path to main': 'text27aefb73a85b',
  'People and service accounts': 'textbc5748dad170',
  'Permissions attach to a principal, for an action, on a resource type.': 'text1672b36c2888',
  person: 'text38a81e87e796',
  'Pipedream credentials for the 3,000+ app catalog — optional, skipped by default — then whether to auto-update nightly.':
    'text5e4f6c67b8fe',
  'Placed in the session at boot, by name, on tmpfs at mode 0600.': 'text8fcebe5ba9b8',
  'Please do not open a public issue for a vulnerability. Mail the security contact with the affected version or commit, the reproduction, and the impact.':
    'textf01a2f914492',
  'Ports 80 and 443, with a domain': 'text3dcb8e2cd245',
  'Postgres, on a directory you control': 'texte43446f5e790',
  Principals: 'text5f31515299e5',
  project: 'text244210e48437',
  'Projects, sessions on their own cloud computers, agents, skills, connectors, channels, triggers, secrets, change requests and the audit record. Nothing on that list is cloud-only.':
    'textf1adb34f55b3',
  'Provider config, just-in-time provisioning, and group-claim mapping. One identity provider per account today.':
    'textaef3f9db6a2e',
  'Pull the log as CSV or JSONL, or have every event posted to your own SIEM over a webhook signed with HMAC-SHA256. Read, export and streaming are Enterprise entitlements.':
    'texteb001458b495',
  'Read the docs': 'text559b1cc46027',
  'Read, run sessions and fire triggers. The project floor role.': 'text3330cf80040f',
  'Recording is never the thing you pay for.': 'text7387eb9a3a98',
  'Responsible disclosure': 'text404238e6cf20',
  'Run it where your policy says it has to run.': 'text7bc05befca96',
  'Run it yourself, or let us run it.': 'textb216cf259699',
  Runtime: 'text109311589787',
  'Same images as the cloud · One command · Any model, your keys': 'text60e3fb7a4521',
  'SAML 2.0 SSO': 'text1e9406a77696',
  'SAML SSO, SCIM directory sync, custom roles, groups and reading the audit log are Enterprise entitlements. On a self-hosted instance they switch on with an Enterprise licence. The built-in owner, admin, member, manager and editor roles are there on every install, and the audit record is written on every install whether or not you can read it back yet.':
    'text2288facc3728',
  sandbox: 'textb7ad567477c8',
  'Sandbox compute is a provider choice: Daytona by default, or Platinum or E2B. Air-gapped and other fully isolated topologies are scoped with us rather than self-served.':
    'text193ea53a9706',
  'SCIM 2.0': 'text98fe74b2a48a',
  'Scope a team to specific agents': 'text7bbd0566a549',
  Secrets: 'textd8707d411d99',
  Security: 'text8f6fb4eb7f42',
  'security@kortix.com': 'text67b8b00d7d81',
  'See enterprise': 'text08c74a58ac03',
  'Self-host free': 'text6cad1856bada',
  'Self-hosted': 'textbeafec79ffdd',
  'Self-hosting is free and always will be. Kortix Cloud is the same product with the box, the upgrades and the sandbox tier taken off your hands.':
    'text2461783e77d5',
  'Self-hosting is not a smaller Kortix with the interesting parts removed. It is the whole control plane — accounts, projects, repos, secrets, connectors, policies, audit — running inside your network, on storage you back up yourself.':
    'text4e1407fe77a8',
  'Send the questionnaire, the architecture questions, the deployment constraints. We would rather answer them properly than have you guess from a marketing page.':
    'text5b643170d839',
  'service account': 'textd7da08389824',
  'Service accounts': 'text1642d9e225e6',
  'Sessions call the gateway inside your own stack, over your own domain or tunnel. Kortix has no credential in that path and no visibility into it.':
    'text23ad3a862df5',
  'Set the default you want': 'text2bf623481fd8',
  Shredded: 'texta69c197df026',
  'Sign-in, invites and SAML': 'text872ebeb07c36',
  'Six questions. Everything else is generated.': 'textf4791d4393c0',
  'SOC 2 Type I': 'text5021004691b4',
  'SOC 2 Type II': 'text35e09f770b81',
  Stack: 'texte551641242ce',
  'Start the stack. Point the CLI at it.': 'text0262678d1309',
  Stored: 'text91da9626894c',
  'supabase-auth': 'text3bc82cc3b576',
  'supabase-db': 'text8ad8f6d178fb',
  'supabase-kong': 'text887c795c54f3',
  'supabase-rest': 'texta4317edba7fd',
  'supabase-storage': 'text031e57c4e32f',
  'Talk to us': 'text1d1d94fb5397',
  'The API and the in-process LLM gateway': 'text22b6584e5811',
  'The company stays on your side of the wall.': 'textbb5b88b1e5a1',
  'The data API': 'text08d90726e8a3',
  'The data-plane gateway': 'text7cb6e2c971b3',
  'The database password, the JWT signing secret and the API keys derived from it':
    'text7d0d0e55bc3e',
  'The file is wiped on shutdown and the machine is destroyed with it.': 'text68631de30841',
  'The frontend, the API and the gateway are the published Kortix images. A self-hosted instance never builds its own — it consumes exactly what the release pipeline already produced.':
    'texte46c387f3dee',
  'The gateway is yours': 'textea59a002b930',
  'The gateway, service and tunnel signing tokens': 'text841050a9c1e6',
  'The image registry the stack pulls from, which needs no credentials': 'text82f1df9d20a8',
  'The LLM gateway your sessions route model calls through': 'text259b154df9fb',
  'The machine clones the repo and cuts a branch named after the session. Every edit and commit that session makes lives on that branch and nowhere else.':
    'textec81d7aae411',
  'The machine is not precious. A bad install or a wiped directory goes away with it. Only what the session commits survives.':
    'text7067d94fd86f',
  'The managed service. We run the control plane and the compute; you run the company.':
    'text568db3e36c44',
  'The person’s role and the agent’s declared grant must both allow it.': 'text01a556bb9792',
  'The Postgres data directory, the storage directory, and the .env that holds every key the instance uses. Back up those three and you have backed up the instance. There is no separate backup service to configure, and nothing to export from us.':
    'textf41f83e58609',
  'The Postgres database, as a directory you can back up': 'text4b3bf58beb3e',
  'The production path. Point a domain and its API subdomain at the box, open 80 and 443, and the bundled proxy takes out a TLS certificate itself.':
    'text91ce76a573e5',
  'The repo is its own history': 'textd2bec415e0a3',
  'The same artifact runs on a laptop, a VPS or a cloud VM. A domain is one environment variable, not a different deployment. Everything lives in one instance directory you can back up by copying it.':
    'text894031366a18',
  'The same images': 'text92f91971fba0',
  'The same Kortix, on your box.': 'textf99aa2b72432',
  'The same product ships as managed cloud, as a stack inside your own network, and as an isolated deployment. Open source, so what you are trusting is code you can read.':
    'textcbb8b2ff8cdf',
  'The same product surface': 'text01ea7ab2073a',
  'The same stack inside your network. Isolated and air-gapped topologies need the sandbox tier moved inside with it, which we scope with you.':
    'text9087fdfc49ff',
  'The session works on its branch': 'text1a03a36926fe',
  'The stack': 'text757d4af22a81',
  'The tool reads it from the environment. It is not written into the prompt.': 'textee94df8de364',
  'The tools, dependencies and runtime the project declares': 'text490f4c702830',
  'The tunnel. Rendered only in tunnel mode': 'textb509788b5f62',
  'The updater checks once a day at a time you set, runs the migration, then starts the new services before it stops the old ones. Track the curated stable channel, ride latest, or pin an exact version and never move.':
    'text931f3ba125af',
  'The web app': 'text5b265f545bde',
  'The whole docker-compose.yml and .env, written at mode 0600': 'text13c531d3fe85',
  'There is no separate provisioning step and no console to click through. One command brings the stack up. One more decides which Kortix your CLI is talking to.':
    'text8bf73992ff9b',
  'This is not a stripped build with the good parts held back for the paid tier. Self-hosted instances run the same images the managed cloud runs, produced by the same pipeline, on the same release train.':
    'textc01240eae6d5',
  'Three actions': 'text4b39312e24c1',
  'Tokens are stored per host, so switching hosts switches the account and the default project with it.':
    'textd7e9af636757',
  'Triage & severity': 'text33d40875a99d',
  trigger: 'text683259feabbf',
  'Two commands': 'text94c41c2953b9',
  'Two gates, not one': 'text1e066af3b6db',
  'Two ways to run it': 'text97b3f2754a46',
  'Unlocks SAML SSO, SCIM directory sync, custom roles, groups and audit read on this instance.':
    'textaea3a7e97183',
  Updates: 'text22e2bada8f1c',
  'Use Kortix Cloud': 'textb627f853304f',
  Used: 'textae7d8dfac9ff',
  'Values are sealed with AES-256-GCM. The key is derived per project with HKDF-SHA256, so one project’s ciphertext cannot be opened with another project’s key. The envelope is versioned, so the scheme can move forward without a flag day.':
    'text1ece34602eea',
  'We credit reporters who want it, once a fix has shipped.': 'text8c1273431a31',
  'We do not hold ISO 27001 or HIPAA, and we do not imply that we do. When a report lands, this line changes that day and not before.':
    'text9008189d76a3',
  'what it asks you': 'text50105c1068fd',
  'what it generates for you': 'text5e9542b94bd5',
  'What it wants': 'text59f765f38854',
  'What we will not claim': 'textc2909469419c',
  'What you keep': 'textcc4a102ab2d7',
  'When the agent wants something to survive the machine, it commits and opens a change request pointed at main. That is the only door.':
    'text69be7710c0fb',
  'Where it runs': 'text6cc00d310273',
  'Where we actually stand': 'textf1b1c08625c2',
  'Whether you hold an Enterprise licence': 'texte18c2658b71a',
  'Who may create organizations': 'text009846255787',
  'Within 3 business days': 'text72b1166237fb',
  'Within 5 business days': 'text91ce3d37da84',
  'Write access to main; a session can only propose': 'text64028cdac85e',
  'You are not handed a template env file to fill in. The CLI asks the handful of things only you can know, generates every port, URL, password, signing key and Compose default itself, and writes the whole instance to one directory.':
    'text5df59d04d374',
  'Your data is two directories and a file': 'text965609f12205',
  'Your own roles and fine-grained policy bindings beyond the presets.': 'textcac616ab8697',
  'Your own VPC or on-prem': 'text2a568b20ca7b',
  'Your provider, your keys': 'text48d12c2f0363',
  'Your sandbox provider and its key': 'text6b23ec7fdf98',
  'Your VPC or on-prem': 'textfbc1c4745323',
};
