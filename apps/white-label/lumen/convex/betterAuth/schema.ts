import { defineSchema } from "convex/server";
import { tables } from "./generatedSchema";

export default defineSchema({
  ...tables,
  // Lumen's membership check reads one (org, user) row.
  member: tables.member.index("organizationId_userId", ["organizationId", "userId"]),
  // The organization plugin lists pending invitations by these fields (Convex warned without them).
  invitation: tables.invitation
    .index("email_organizationId_status", ["email", "organizationId", "status"])
    .index("organizationId_status", ["organizationId", "status"]),
});
