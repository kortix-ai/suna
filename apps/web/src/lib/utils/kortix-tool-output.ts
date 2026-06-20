/**
 * Shared parsing utilities for Kortix Orchestrator tool outputs.
 * These are used by both inline renderers and side panel tool views.
 */

// ============================================================================
// Project Tools
// ============================================================================

export interface ProjectEntry {
	name: string;
	path: string;
	sessions: number;
	description: string;
}

export function parseProjectListOutput(output: string): ProjectEntry[] {
	if (!output || typeof output !== 'string') return [];
	const projects: ProjectEntry[] = [];

	// Try 4-column format first: | **name** | `/path` | sessions | description |
	const fourColRe = /^\|\s*\*\*([^*]+)\*\*\s*\|\s*`([^`]+)`\s*\|\s*(\d+)\s*\|\s*([^|]*?)\s*\|$/gm;
	let m;
	while ((m = fourColRe.exec(output)) !== null) {
		projects.push({
			name: m[1].trim(),
			path: m[2].trim(),
			sessions: parseInt(m[3], 10) || 0,
			description: m[4].trim() || '—',
		});
	}
	if (projects.length > 0) return projects;

	// Fallback: 3-column format: | **name** | `/path` | description |
	const threeColRe = /^\|\s*\*\*([^*]+)\*\*\s*\|\s*`([^`]+)`\s*\|\s*([^|]*?)\s*\|$/gm;
	while ((m = threeColRe.exec(output)) !== null) {
		projects.push({
			name: m[1].trim(),
			path: m[2].trim(),
			sessions: 0,
			description: m[3].trim() || '—',
		});
	}
	return projects;
}

export interface ProjectGetData {
	name: string;
	path: string;
	description: string | null;
	id: string;
	sessions: Array<{ status: string; count: number }>;
	contextExists: boolean;
	contextPath: string;
}

export function parseProjectGetOutput(output: string): ProjectGetData | null {
	if (!output || typeof output !== 'string') return null;

	const nameMatch = output.match(/^##\s+(.+)$/m);
	const pathMatch = output.match(/\*\*Path:\*\*\s+`([^`]+)`/);
	const descMatch = output.match(/\*\*Description:\*\*\s+(.+)$/m);
	const idMatch = output.match(/\*\*ID:\*\*\s+`([^`]+)`/);
	const contextMatch = output.match(/\*\*Context:\*\*\s+`([^`]+)`\s*([✓✓])?/);
	const contextExists = !!contextMatch?.[2];
	const contextPath = contextMatch?.[1] || '';

	// Sessions section
	const sessions: Array<{ status: string; count: number }> = [];
	const bulletRe = /^-\s+(running|completed|failed|pending):\s+(\d+)/gm;
	let sm;
	while ((sm = bulletRe.exec(output)) !== null) {
		sessions.push({
			status: sm[1],
			count: parseInt(sm[2], 10) || 0,
		});
	}

	return {
		name: nameMatch?.[1] || 'Unknown Project',
		path: pathMatch?.[1] || '',
		description: descMatch?.[1] || null,
		id: idMatch?.[1] || '',
		sessions,
		contextExists,
		contextPath,
	};
}

export interface ProjectSelectData {
	name: string;
	path: string;
	success: boolean;
}

export function parseProjectSelectOutput(output: string): ProjectSelectData | null {
	if (!output || typeof output !== 'string') return null;
	const nameMatch = output.match(/Project\s+\*\*([^*]+)\*\*\s+selected/i);
	const pathMatch = output.match(/Path:\s+`([^`]+)`/);
	if (!nameMatch) return null;
	return {
		name: nameMatch[1],
		path: pathMatch?.[1] || '',
		success: !!nameMatch && output.includes('selected'),
	};
}

export interface ProjectCreateData {
	name: string;
	path: string;
	id: string;
	success: boolean;
}

export function parseProjectCreateOutput(output: string): ProjectCreateData | null {
	if (!output || typeof output !== 'string') return null;
	const nameMatch = output.match(/Project\s+\*\*([^*]+)\*\*\s+at/i);
	const pathMatch = output.match(/at\s+`([^`]+)`/);
	const idMatch = output.match(/\((proj-[^)]+)\)/);
	if (!nameMatch) return null;
	return {
		name: nameMatch[1],
		path: pathMatch?.[1] || '',
		id: idMatch?.[1] || '',
		success: !!nameMatch && !output.toLowerCase().includes('failed'),
	};
}

// ============================================================================
// Connector Tools
// ============================================================================

export interface ConnectorEntry {
	name: string;
	description: string;
	source: string;
}

export function parseConnectorListOutput(output: string): ConnectorEntry[] {
	if (!output || typeof output !== 'string') return [];
	const connectors: ConnectorEntry[] = [];
	// Parse markdown table: | Name | Description | Source |
	const lineRe = /^\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]*?)\s*\|$/gm;
	let m;
	while ((m = lineRe.exec(output)) !== null) {
		const name = m[1].trim();
		// Skip header row and separator row
		if (name === 'Name' || name.startsWith('---') || name.startsWith('–')) continue;
		connectors.push({
			name,
			description: m[2].trim(),
			source: m[3].trim(),
		});
	}
	return connectors;
}

export interface ConnectorGetData {
	name: string;
	description: string;
	source: string;
	env?: string;
	notes?: string;
}

export function parseConnectorGetOutput(output: string): ConnectorGetData | null {
	if (!output || typeof output !== 'string') return null;

	const nameMatch = output.match(/^name:\s*(.+)$/m);
	const descriptionMatch = output.match(/^description:\s*(.+)$/m);
	const sourceMatch = output.match(/^source:\s*(.+)$/m);
	const envMatch = output.match(/^env:\s*(.+)$/m);
	const notesMatch = output.match(/^notes:\s*\n([\s\S]*?)$/);

	if (!nameMatch) return null;

	return {
		name: nameMatch[1].trim(),
		description: descriptionMatch?.[1].trim() || '',
		source: sourceMatch?.[1].trim() || 'unknown',
		env: envMatch?.[1].trim(),
		notes: notesMatch?.[1].trim(),
	};
}

export interface ConnectorSetupData {
	count: number;
	connectors: string[];
	success: boolean;
}

export function parseConnectorSetupOutput(output: string): ConnectorSetupData | null {
	if (!output || typeof output !== 'string') return null;

	// Match "Created/updated X connectors:" or legacy "Scaffolded X connectors"
	const countMatch = output.match(/(?:Created\/updated|Scaffolded)\s+(\d+)\s+connectors/i);
	const count = countMatch ? parseInt(countMatch[1], 10) : 0;

	const connectors: string[] = [];
	// Parse: name (source)
	const lineRe = /^([^\s(]+)\s*\(([^)]+)\)/gm;
	let m;
	while ((m = lineRe.exec(output)) !== null) {
		connectors.push(`${m[1].trim()} (${m[2].trim()})`);
	}

	return {
		count,
		connectors,
		success: count > 0,
	};
}
