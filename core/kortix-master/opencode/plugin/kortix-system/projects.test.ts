import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { GLOBAL_PROJECT_ID, ProjectManager, initProjectsDb, projectStatusTransform, shouldInjectUnboundProjectStatus } from "./projects"
import { ensureTicketTables, listColumns } from "../../../src/services/ticket-service"

function makeOutput(text: string) {
	return {
		messages: [
			{
				info: { role: "user", sessionID: "ses-test" },
				parts: [{ type: "text", text }],
			},
		],
	}
}

describe("global project policy", () => {
	test("project status injection is disabled for every prompt", async () => {
		const output = makeOutput("create a project for billing cleanup")

		await projectStatusTransform({} as any, () => "ses-test")({}, output)

		expect(output.messages[0]?.parts).toHaveLength(1)
		expect(shouldInjectUnboundProjectStatus("create a project for x")).toBe(false)
	})

	test("every session resolves to the implicit global workspace", () => {
		const root = mkdtempSync(path.join(tmpdir(), "kortix-global-project-"))
		try {
			const db = initProjectsDb(path.join(root, ".kortix", "kortix.db"))
			ensureTicketTables(db)
			const mgr = new ProjectManager({ session: {}, app: { log: async () => {} } }, root, db)

			const first = mgr.getSessionProject("ses-a")!
			const second = mgr.getSessionProject("ses-b")!

			expect(first.id).toBe(GLOBAL_PROJECT_ID)
			expect(second.id).toBe(GLOBAL_PROJECT_ID)
			expect(first.path).toBe(root)
			expect(mgr.listProjects()).toHaveLength(1)
			expect(mgr.getProject("anything")?.id).toBe(GLOBAL_PROJECT_ID)
			expect(listColumns(db, GLOBAL_PROJECT_ID).map((c) => c.key)).toEqual(["backlog", "in_progress", "review", "done"])

			const linked = db.prepare("SELECT project_id FROM session_projects WHERE session_id=$sid").get({ $sid: "ses-a" }) as { project_id: string } | null
			expect(linked?.project_id).toBe(GLOBAL_PROJECT_ID)
			db.close()
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})
})
