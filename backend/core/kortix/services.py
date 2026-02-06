"""
Kortix Tools Services

Implementations for web search and image search.
"""

import httpx
from typing import List, Optional, Dict, Any, Literal
from dataclasses import dataclass
from core.utils.logger import logger
from .config import TAVILY_API_KEY, SERPER_API_KEY


@dataclass
class WebSearchResult:
    title: str
    url: str
    snippet: str
    published_date: Optional[str] = None


@dataclass
class ImageSearchResult:
    title: str
    url: str
    thumbnail_url: str
    source_url: str
    width: Optional[int] = None
    height: Optional[int] = None


async def web_search_tavily(
    query: str,
    max_results: int = 5,
    search_depth: Literal["basic", "advanced"] = "basic",
) -> List[WebSearchResult]:
    """
    Search the web using Tavily API.

    Args:
        query: Search query
        max_results: Maximum number of results (1-10)
        search_depth: "basic" or "advanced"

    Returns:
        List of WebSearchResult
    """
    if not TAVILY_API_KEY:
        raise ValueError("TAVILY_API_KEY not configured")

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            "https://api.tavily.com/search",
            json={
                "api_key": TAVILY_API_KEY,
                "query": query,
                "search_depth": search_depth,
                "max_results": min(max_results, 10),
                "include_answer": False,
                "include_raw_content": False,
            },
        )
        response.raise_for_status()
        data = response.json()

    results = []
    for item in data.get("results", []):
        results.append(
            WebSearchResult(
                title=item.get("title", ""),
                url=item.get("url", ""),
                snippet=item.get("content", ""),
                published_date=item.get("published_date"),
            )
        )

    logger.info(f"[KORTIX] Web search for '{query}' returned {len(results)} results")
    return results


async def image_search_serper(
    query: str,
    max_results: int = 5,
    safe_search: bool = True,
) -> List[ImageSearchResult]:
    """
    Search for images using Serper API (Google Images).

    Args:
        query: Search query
        max_results: Maximum number of results (1-20)
        safe_search: Enable safe search filtering

    Returns:
        List of ImageSearchResult
    """
    if not SERPER_API_KEY:
        raise ValueError("SERPER_API_KEY not configured")

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            "https://google.serper.dev/images",
            headers={
                "X-API-KEY": SERPER_API_KEY,
                "Content-Type": "application/json",
            },
            json={
                "q": query,
                "num": min(max_results, 20),
                "safe": "active" if safe_search else "off",
            },
        )
        response.raise_for_status()
        data = response.json()

    results = []
    for item in data.get("images", []):
        results.append(
            ImageSearchResult(
                title=item.get("title", ""),
                url=item.get("imageUrl", ""),
                thumbnail_url=item.get("thumbnailUrl", item.get("imageUrl", "")),
                source_url=item.get("link", ""),
                width=item.get("imageWidth"),
                height=item.get("imageHeight"),
            )
        )

    logger.info(f"[KORTIX] Image search for '{query}' returned {len(results)} results")
    return results
