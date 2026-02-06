"""
Kortix Tools API Router

Provides endpoints for Kortix OpenCode plugin tools.
"""

from fastapi import APIRouter, HTTPException, Depends, Header
from pydantic import BaseModel, Field
from typing import Optional, List, Literal
from dataclasses import asdict

from core.utils.logger import logger
from .services import (
    web_search_tavily,
    image_search_serper,
    WebSearchResult,
    ImageSearchResult,
)
from .billing import kortix_billing


router = APIRouter(prefix="/kortix", tags=["kortix"])


# === Token Validation ===


async def validate_kortix_token(authorization: str = Header(None)) -> str:
    """Validate KORTIX_TOKEN and return account_id."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")

    token = authorization[7:]  # Remove "Bearer "

    # For testing: "00000" token = skip billing
    if token == "00000":
        return "test_account"

    # TODO: Real token validation - lookup token in DB to get account_id
    # For now, treat token as account_id directly (temporary)
    return token


# === Request/Response Models ===


class WebSearchRequest(BaseModel):
    query: str = Field(..., description="Search query")
    max_results: int = Field(5, ge=1, le=10, description="Maximum results to return")
    search_depth: Literal["basic", "advanced"] = Field(
        "basic", description="Search depth"
    )
    session_id: Optional[str] = Field(None, description="OpenCode session ID")


class WebSearchResultModel(BaseModel):
    title: str
    url: str
    snippet: str
    published_date: Optional[str] = None


class WebSearchResponse(BaseModel):
    results: List[WebSearchResultModel]
    query: str
    cost: float


class ImageSearchRequest(BaseModel):
    query: str = Field(..., description="Search query")
    max_results: int = Field(5, ge=1, le=20, description="Maximum results to return")
    safe_search: bool = Field(True, description="Enable safe search")
    session_id: Optional[str] = Field(None, description="OpenCode session ID")


class ImageSearchResultModel(BaseModel):
    title: str
    url: str
    thumbnail_url: str
    source_url: str
    width: Optional[int] = None
    height: Optional[int] = None


class ImageSearchResponse(BaseModel):
    results: List[ImageSearchResultModel]
    query: str
    cost: float


# === Endpoints ===


@router.post("/web-search", response_model=WebSearchResponse)
async def web_search(
    request: WebSearchRequest,
    account_id: str = Depends(validate_kortix_token),
):
    """
    Search the web using Tavily API.

    Requires authentication via KORTIX_TOKEN.
    Credits are deducted based on search depth (basic or advanced).
    """

    # Determine tool name based on search depth
    tool_name = f"web_search_{request.search_depth}"

    # Check credits
    has_credits, message, _ = await kortix_billing.check_credits(account_id)
    if not has_credits:
        raise HTTPException(status_code=402, detail=message)

    try:
        # Perform search
        results = await web_search_tavily(
            query=request.query,
            max_results=request.max_results,
            search_depth=request.search_depth,
        )

        # Deduct credits
        billing_result = await kortix_billing.deduct_tool_credits(
            account_id=account_id,
            tool_name=tool_name,
            result_count=len(results),
            description=f"Web search: {request.query[:50]}",
            session_id=request.session_id,
        )

        if not billing_result.get("success") and not billing_result.get("skipped"):
            logger.warning(
                f"[KORTIX] Billing failed for {account_id} but returning results anyway"
            )

        return WebSearchResponse(
            results=[
                WebSearchResultModel(
                    title=r.title,
                    url=r.url,
                    snippet=r.snippet,
                    published_date=r.published_date,
                )
                for r in results
            ],
            query=request.query,
            cost=billing_result.get("cost", 0),
        )

    except ValueError as e:
        logger.error(f"[KORTIX] Web search config error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        logger.error(f"[KORTIX] Web search error: {e}")
        raise HTTPException(status_code=500, detail=f"Search failed: {str(e)}")


@router.post("/image-search", response_model=ImageSearchResponse)
async def image_search(
    request: ImageSearchRequest,
    account_id: str = Depends(validate_kortix_token),
):
    """
    Search for images using Serper API (Google Images).

    Requires authentication via KORTIX_TOKEN.
    Credits are deducted per search.
    """

    # Check credits
    has_credits, message, _ = await kortix_billing.check_credits(account_id)
    if not has_credits:
        raise HTTPException(status_code=402, detail=message)

    try:
        # Perform search
        results = await image_search_serper(
            query=request.query,
            max_results=request.max_results,
            safe_search=request.safe_search,
        )

        # Deduct credits
        billing_result = await kortix_billing.deduct_tool_credits(
            account_id=account_id,
            tool_name="image_search",
            result_count=len(results),
            description=f"Image search: {request.query[:50]}",
            session_id=request.session_id,
        )

        if not billing_result.get("success") and not billing_result.get("skipped"):
            logger.warning(
                f"[KORTIX] Billing failed for {account_id} but returning results anyway"
            )

        return ImageSearchResponse(
            results=[
                ImageSearchResultModel(
                    title=r.title,
                    url=r.url,
                    thumbnail_url=r.thumbnail_url,
                    source_url=r.source_url,
                    width=r.width,
                    height=r.height,
                )
                for r in results
            ],
            query=request.query,
            cost=billing_result.get("cost", 0),
        )

    except ValueError as e:
        logger.error(f"[KORTIX] Image search config error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        logger.error(f"[KORTIX] Image search error: {e}")
        raise HTTPException(status_code=500, detail=f"Search failed: {str(e)}")
