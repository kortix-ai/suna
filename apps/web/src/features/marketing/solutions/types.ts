/**
 * `/solutions/<role>` — the shape every role page fills in.
 *
 * ==========================================================================
 * ACCURACY GATE — read before writing one word of a role page.
 * ==========================================================================
 * These pages describe autonomous work, which is exactly where marketing copy
 * starts claiming a product we do not ship. Every role file is bound by this:
 *
 *  - MERGE IS DEFAULT-DENY. Work lands through a change request. An admin can
 *    grant `project.cr.merge` in `kortix.yaml`; widening it is itself a
 *    reviewed change. Never write "only a human can merge" and never write
 *    "the agent deploys".
 *  - APPROVAL GATES ARE OFF BY DEFAULT. `policy.default_mode` falls back to
 *    `allow_all`. Always say "set Ask and Block explicitly" — never "gates are
 *    on" or "writes require approval by default".
 *  - CONNECTORS ONLY. Name a third-party tool only if it is genuinely
 *    reachable through the connector catalogue. Easy connect is a hosted
 *    catalogue of 3,000+ OAuth apps; MCP, OpenAPI, GraphQL and raw HTTP cover
 *    the rest. If a role's obvious tool is not reachable, describe the
 *    capability instead of naming the brand.
 *  - CONNECTOR credentials are brokered server-side and never enter the
 *    machine. A granted RUNTIME secret is a real env value in the session and
 *    IS readable by any command the agent runs
 *    (`docs/ENV_SECRET_EXPOSURE_BASELINE.md`). NEVER write "secrets the model
 *    cannot see" about runtime secrets.
 *  - CHANNELS ARE A CLOSED ENUM: Slack live, Teams behind an operator switch,
 *    email experimental. Telegram, WhatsApp, SMS and Discord are NOT
 *    channels, in any tense.
 *  - NEVER claim egress is controlled at the network. NEVER claim microVM
 *    isolation as a blanket fact (true for the Platinum provider only).
 *  - SELF-HOSTING IS NOT AIR-GAPPED. `kortix self-host start` pulls images
 *    from docker.io. Route isolated topologies to Enterprise.
 *  - NEVER name a license — say "open source" and stop. NEVER claim a
 *    certification; link to /security instead of asserting compliance.
 *  - NO CUSTOMER NAMES, EVER. Fictional placeholders only: Acme, Northwind,
 *    Globex. This applies to sample artifacts as much as to prose.
 *  - NO INVENTED METRICS. No "3x faster", no "saves 12 hours a week", no
 *    adoption counts. The only sanctioned number is the live GitHub star
 *    count, which lives in the navbar, not here.
 *  - ONE SANCTIONED SUPERLATIVE FORM: "the leading open-source alternative".
 *    No other superlative, ever.
 *
 * Voice rules: the `comms` skill. The product noun is CONNECTOR, never
 * "integration"; SESSION, never "chat"; CLOUD COMPUTER or SANDBOX, never
 * "container"; CHANGE REQUEST, never "PR" in prose.
 */

/**
 * The sample output a role page shows. Four shapes, because eight roles do not
 * produce the same object: engineering returns a patch, finance returns a
 * reconciliation, data science returns a query, and the writing roles return a
 * document. A shared shape would be the tell that these pages are one template.
 */
export type RoleArtifact =
  | {
      kind: 'diff';
      /** Path as it appears on the session branch. */
      file: string;
      /** Lines beginning with `+`, `-`, or a space, as a real unified diff. */
      lines: readonly string[];
      /** e.g. `+18 −6`. */
      stat: string;
    }
  | {
      kind: 'table';
      file: string;
      columns: readonly string[];
      /** Column widths as CSS percentages, one per column. */
      widths: readonly string[];
      rows: readonly { readonly cells: readonly string[] }[];
    }
  | {
      kind: 'doc';
      file: string;
      title: string;
      /** Body paragraphs. Short — this is a specimen, not the real document. */
      lines: readonly string[];
      /** Field label / value pairs rendered above the body. */
      meta: readonly { readonly k: string; readonly v: string }[];
    }
  | {
      kind: 'code';
      file: string;
      lang: 'sql' | 'sh' | 'yaml';
      lines: readonly string[];
    };

export type RoleContent = {
  /** URL segment. `/solutions/<slug>`. */
  slug: string;
  /** The label used in the nav, the hub grid and the cross-link row. */
  name: string;
  /** One line for the nav menu and the hub card. Sentence case, no full stop. */
  navDescription: string;
  /** `<title>` and the SEO record title. */
  seoTitle: string;
  /** Meta description. One or two sentences, concrete. */
  seoDescription: string;

  hero: {
    title: string;
    sub: string;
    microline: string;
    /** Four mono facts. Every value must be defensible against the code. */
    specs: readonly { readonly k: string; readonly v: string }[];
  };

  /** What this role can hand off. Four to six real jobs, not capabilities. */
  handoff: {
    title: string;
    sub: string;
    jobs: readonly { readonly id: string; readonly title: string; readonly body: string }[];
  };

  /** What comes back, shown as a specimen artifact plus the honest framing. */
  output: {
    title: string;
    sub: string;
    artifact: RoleArtifact;
    /** Caption under the specimen. Always states that it is an illustration. */
    caption: string;
    /** Three short notes about the form the output takes for this role. */
    notes: readonly { readonly id: string; readonly title: string; readonly body: string }[];
  };

  /** The connectors that matter to this role, and what the agent does with each. */
  reach: {
    title: string;
    sub: string;
    rows: readonly { readonly k: string; readonly v: string }[];
    /** The honest footnote about anything the catalogue does not cover. */
    footnote: string;
  };

  /** On-demand, human-assisted, automated — told in this role's cadence. */
  cadence: {
    title: string;
    sub: string;
    modes: readonly {
      readonly id: 'on-demand' | 'human-assisted' | 'automated';
      readonly label: string;
      readonly title: string;
      readonly body: string;
    }[];
  };

  /** The control section. Every role page carries it; the framing is per role. */
  control: {
    title: string;
    sub: string;
    rows: readonly { readonly id: string; readonly k: string; readonly v: string }[];
  };

  closing: {
    title: string;
    sub: string;
  };
};
