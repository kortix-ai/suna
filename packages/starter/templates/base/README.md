# {{projectName}}

This project runs OpenCode through its REST API.

## Authentication

OpenCode can use Kortix-managed models or project provider credentials.

## Web search

The `web_search` tool uses Tavily by default. Kortix routes Tavily requests through
its API when available. A self-hosted direct Tavily setup needs `TAVILY_API_KEY`.

To use Parallel Search MCP for one search, set `provider: "parallel"` in the
`web_search` tool call. The tool calls `https://search.parallel.ai/mcp` without a
Parallel account or API key. Free anonymous access is rate limited. Parallel
returns source URLs and excerpts. It does not provide Tavily's answer, images,
scores, `topic`, or `search_depth`. The tool rejects those two options when
Parallel is selected. `num_results` limits the results shown after the search.

Queries and the tool objective are sent to Parallel when selected. The request
also identifies the project as `Kortix` so Parallel can measure aggregate
usage. See the [Parallel Search MCP documentation](https://docs.parallel.ai/integrations/mcp/search-mcp)
and [privacy policy](https://parallel.ai/privacy-policy) for service details.

## Verify the project

## Test the runtime

1. Create a session.
2. Send a real prompt.
3. Confirm that the response completes.

A provider availability check does not prove prompt execution. Test the model
that the project will use.

Run `kortix system-skills get kortix-system --full` for the current platform
instructions. Run `kortix schema --version 2` for the exact manifest schema.
