# Call connectors from an App

An App reaches Gmail, a CRM or any connected system through Kortix
connectors and `@kortix/sdk`. Prefer a connector over a raw provider API key:
the connector gateway applies the project's policy, approvals and audit. The
full recipes and error answers are in the `kortix-connectors` skill
(`kortix system-skills get kortix-connectors`, `<from-apps-and-backends>`).

| Where the code runs | Credential | Reaches |
| --- | --- | --- |
| An App in the browser | `createKortix({ backendUrl: '/_kortix/api/v1', getToken: kortixAppViewerToken() })`, App set to `--viewer api` | The viewer's shared and private accounts |
| An App's server | `createAppViewerKortix(request, { backendUrl })` from `@kortix/sdk/server`, per request | The same |
| A `convex` App's action, an App job with no viewer | A service account bearer (`kortix_sa_…`) in an environment variable | Shared accounts nobody narrowed; never a private one |

## A service account for a `convex` App

**The credential is a human step.** Kortix does not mint a credential for App
code. Ask the user to run:

```sh
kortix tokens service-accounts new crm-sync --description "CRM sync"    # the bearer prints once
kortix access grant --service-account <id> --role member --project <project-id>
```

An agent session cannot do this for them. They store the bearer with
`npx convex env set KORTIX_API_KEY` (value on stdin). Build the rest while you
wait. Then set, with `npx convex env set`:

- `KORTIX_API_URL`: the Kortix API with `/v1` (`https://api.kortix.com/v1` on
  Kortix cloud).
- `KORTIX_PROJECT_ID`: the project id.

```ts
"use node";
import { internalAction } from "./_generated/server";
import { createKortix } from "@kortix/sdk";

export const syncDeals = internalAction({
  args: {},
  handler: async () => {
    const kortix = createKortix({
      backendUrl: process.env.KORTIX_API_URL!,
      getToken: async () => process.env.KORTIX_API_KEY!,
    });
    return await kortix
      .project(process.env.KORTIX_PROJECT_ID!)
      .connector("crm").run("list_deals", { stage: "won" });
  },
});
```

Anyone with the App's admin credentials reads the bearer from the Convex
environment. To start an agent from a `convex` App, POST the project's
webhook trigger from an action, with its secret in a Convex environment
variable (kortix-system, scheduling).
