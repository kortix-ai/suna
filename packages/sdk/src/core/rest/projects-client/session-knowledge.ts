import { backendApi } from "../../http/api-client";
import { unwrap } from "./shared";

export interface RetrievalCitation {
  citation_id: string;
  source_id: string;
  source_slug: string;
  source_title: string;
  version_id: string;
  locator: {
    page?: number;
    url?: string;
    heading?: string;
    row?: number;
  };
}

export interface AgentKnowledgeSearchResult {
  content: string;
  score: number;
  lexical_score: number | null;
  vector_score: number | null;
  citation: RetrievalCitation;
}

export interface AgentKnowledgeSearchResponse {
  results: AgentKnowledgeSearchResult[];
  mode: "hybrid" | "lexical";
  degraded_reason: string | null;
}

export interface AgentKnowledgeReadResponse {
  content: string;
  citation: RetrievalCitation;
}

export interface SearchSessionKnowledgeInput {
  query: string;
  limit?: number;
}

const sessionBase = (projectId: string, sessionId: string) =>
  `/projects/${projectId}/sessions/${encodeURIComponent(sessionId)}/knowledge`;

export async function searchSessionKnowledge(
  projectId: string,
  sessionId: string,
  input: SearchSessionKnowledgeInput,
) {
  return unwrap(
    await backendApi.post<AgentKnowledgeSearchResponse>(
      `${sessionBase(projectId, sessionId)}/search`,
      { ...input, limit: input.limit ?? 8 },
    ),
  );
}

export async function readSessionKnowledge(
  projectId: string,
  sessionId: string,
  citationId: string,
) {
  return unwrap(
    await backendApi.get<AgentKnowledgeReadResponse>(
      `${sessionBase(projectId, sessionId)}/${encodeURIComponent(citationId)}`,
    ),
  );
}
