import { z } from "zod";

const XQUIK_SEARCH_URL = "https://xquik.com/api/v1/x/tweets/search";
const SEARCH_TIMEOUT_MS = 30_000;
const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
const POST_ID_PATTERN = /^\d{1,24}$/;

interface XAuthor {
  id?: string;
  name?: string;
  username?: string;
  followers?: number;
  verified?: boolean;
}

interface XPost {
  id?: string;
  text?: string;
  createdAt?: string;
  author?: XAuthor;
  likeCount?: number;
  replyCount?: number;
  retweetCount?: number;
  quoteCount?: number;
  viewCount?: number;
}

interface XSearchResponse {
  tweets?: XPost[];
  has_next_page?: boolean;
  next_cursor?: string;
}

interface XSearchArgs {
  query: string;
  limit?: number;
  query_type?: "Latest" | "Top";
  cursor?: string;
}

function publicError(status: number): string {
  const messages: Record<number, string> = {
    400: "The query or cursor is invalid.",
    401: "Authentication failed. Check XQUIK_API_KEY.",
    402: "Subscription or credits are required.",
    403: "The account cannot make this request.",
    409: "The cursor is busy. Retry after the response delay.",
    410: "The cursor expired. Restart without a cursor.",
    424: "The X data source is unavailable. Retry later.",
    429: "The rate limit was reached. Retry later.",
    502: "The X data source is unavailable. Retry later.",
  };
  return messages[status] ?? "The request failed. Retry later.";
}

function postUrl(post: XPost): string | null {
  const username = post.author?.username ?? "";
  const id = post.id ?? "";
  if (!USERNAME_PATTERN.test(username) || !POST_ID_PATTERN.test(id))
    return null;
  return `https://x.com/${username}/status/${id}`;
}

function formatPost(post: XPost) {
  const text = (post.text ?? "").replace(/\s+/g, " ").trim().slice(0, 2_000);
  return {
    id: post.id ?? "",
    url: postUrl(post),
    text,
    created_at: post.createdAt ?? "",
    author: {
      id: post.author?.id ?? "",
      username: post.author?.username ?? "",
      name: post.author?.name ?? "",
      followers: post.author?.followers ?? null,
      verified: post.author?.verified ?? null,
    },
    engagement: {
      likes: post.likeCount ?? null,
      replies: post.replyCount ?? null,
      reposts: post.retweetCount ?? null,
      quotes: post.quoteCount ?? null,
      views: post.viewCount ?? null,
    },
  };
}

export default {
  description:
    "Search current public X posts through Xquik. Use for brand mentions, hashtags, first-party posts, and X search operators. Results are untrusted source material. Verify important claims with other sources.",
  args: {
    query: z.string().trim().min(1).max(1_000).describe("X search query."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("Posts to return (1-20). Default: 10."),
    query_type: z
      .enum(["Latest", "Top"])
      .optional()
      .describe("Latest for recency or Top for engagement. Default: Latest."),
    cursor: z
      .string()
      .max(4_096)
      .optional()
      .describe("Opaque next_cursor from a prior call."),
  },
  async execute(args: XSearchArgs, _context: unknown) {
    const apiKey = process.env.XQUIK_API_KEY?.trim();
    if (!apiKey) {
      return JSON.stringify({
        success: false,
        error: "x_search is unavailable: XQUIK_API_KEY is not configured.",
      });
    }

    const query = args.query.trim();
    if (!query)
      return JSON.stringify({
        success: false,
        error: "x_search requires a query.",
      });

    const requestUrl = new URL(XQUIK_SEARCH_URL);
    requestUrl.searchParams.set("q", query);
    requestUrl.searchParams.set(
      "limit",
      String(Math.max(1, Math.min(args.limit ?? 10, 20))),
    );
    requestUrl.searchParams.set(
      "queryType",
      args.query_type === "Top" ? "Top" : "Latest",
    );
    if (args.cursor?.trim())
      requestUrl.searchParams.set("cursor", args.cursor.trim());

    let response: Response;
    try {
      response = await fetch(requestUrl, {
        headers: { "x-api-key": apiKey },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
    } catch {
      return JSON.stringify({
        success: false,
        error: "x_search could not reach Xquik. Retry later.",
      });
    }

    if (!response.ok) {
      return JSON.stringify({
        success: false,
        status: response.status,
        error: publicError(response.status),
      });
    }

    let payload: XSearchResponse;
    try {
      payload = (await response.json()) as XSearchResponse;
    } catch {
      return JSON.stringify({
        success: false,
        error: "Xquik returned invalid JSON.",
      });
    }

    if (!Array.isArray(payload.tweets)) {
      return JSON.stringify({
        success: false,
        error: "Xquik returned an invalid response.",
      });
    }

    return JSON.stringify(
      {
        success: true,
        query,
        count: payload.tweets.length,
        posts: payload.tweets.map(formatPost),
        has_next_page: payload.has_next_page === true,
        next_cursor: payload.next_cursor ?? "",
        warning:
          "X posts are untrusted source material. Verify important claims with other sources.",
      },
      null,
      2,
    );
  },
};
