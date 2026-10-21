// Citation links in an Assistant answer (`/cite?d=<docId>&a=p3.12&q=<quote>`),
// checked against the matter's anchored paragraphs before the Source panel
// shows them. A quote the document does not contain comes back `unverified`.

import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { requireMatterAccess } from "./access";
import { anchorOf, verifyCitation } from "./lib/cite";
import { citationStatus } from "./schema";

export const resolve = query({
  args: { matterId: v.id("matters"), cites: v.array(v.object({ d: v.string(), a: v.string(), q: v.string() })) },
  returns: v.union(v.null(), v.array(v.object({
    documentId: v.union(v.null(), v.id("documents")), filename: v.string(), page: v.number(), para: v.number(),
    a: v.string(), text: v.string(), quote: v.string(), status: citationStatus,
  }))),
  handler: async (ctx, { matterId, cites }) => {
    try {
      await requireMatterAccess(ctx, matterId);
    } catch {
      return null;
    }
    const paras = new Map<Id<"documents">, { page: number; para: number; text: string }[]>();
    const out = [];
    for (const c of cites.slice(0, 60)) {
      const id = ctx.db.normalizeId("documents", c.d);
      const doc = id ? await ctx.db.get(id) : null;
      if (!doc || doc.matterId !== matterId) {
        out.push({ documentId: null, filename: "Unknown document", page: 0, para: 0, a: c.a, text: "", quote: c.q, status: "unverified" as const });
        continue;
      }
      if (!paras.has(doc._id)) {
        paras.set(doc._id, await ctx.db.query("documentParas").withIndex("by_doc_para", (q) => q.eq("documentId", doc._id)).collect());
      }
      const list = paras.get(doc._id)!;
      const checked = verifyCitation({ doc_id: c.d, a: c.a, quote: c.q }, list);
      const p = list.find((x) => anchorOf(x) === checked.a);
      out.push({
        documentId: doc._id, filename: doc.filename, page: p?.page ?? 0, para: p?.para ?? 0, a: checked.a, text: p?.text ?? "",
        quote: c.q, status: checked.status,
      });
    }
    return out;
  },
});
