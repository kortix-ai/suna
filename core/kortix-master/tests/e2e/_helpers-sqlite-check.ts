import { Database } from "bun:sqlite";

const db = new Database("/workspace/.kortix/kortix.db", { readonly: true });
const projects = (db.prepare("SELECT COUNT(*) AS c FROM projects").get() as { c: number }).c;
let tickets = -1;
try { tickets = (db.prepare("SELECT COUNT(*) AS c FROM tickets").get() as { c: number }).c; } catch { /* table may not exist */ }
let columns = -1;
try { columns = (db.prepare("SELECT COUNT(*) AS c FROM project_columns").get() as { c: number }).c; } catch {}
let milestones = -1;
try { milestones = (db.prepare("SELECT COUNT(*) AS c FROM milestones").get() as { c: number }).c; } catch {}

console.log(JSON.stringify({ projects, tickets, columns, milestones }));
