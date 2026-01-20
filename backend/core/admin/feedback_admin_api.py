from fastapi import APIRouter, HTTPException, Depends, Query
from typing import Optional, List
from datetime import datetime, timezone
from pydantic import BaseModel
from core.auth import require_admin
from core.utils.logger import logger
from core.utils.pagination import PaginationParams, PaginatedResponse, PaginationService
from core.admin import feedback_repo

router = APIRouter(prefix="/admin/feedback", tags=["admin", "feedback"])

class FeedbackWithUser(BaseModel):
    feedback_id: str
    account_id: Optional[str] = None
    user_email: str
    rating: float
    feedback_text: Optional[str] = None
    help_improve: bool
    thread_id: Optional[str] = None
    message_id: Optional[str] = None
    context: Optional[dict] = None
    created_at: str
    updated_at: str

class FeedbackStats(BaseModel):
    total_feedback: int
    average_rating: float
    total_with_text: int
    rating_distribution: dict

class SentimentSummary(BaseModel):
    total: int
    positive: int
    neutral: int
    negative: int
    five_star: int
    critical: int
    positive_percentage: float
    negative_percentage: float

class TimeSeriesPoint(BaseModel):
    period: str
    count: int
    avg_rating: float
    positive_count: int
    negative_count: int
    with_text_count: int

class RatingTrends(BaseModel):
    periods: List[str]
    data: dict

class CriticalFeedback(BaseModel):
    feedback_id: str
    rating: float
    feedback_text: str
    created_at: str
    thread_id: Optional[str] = None
    user_email: str

class LLMAnalysisRequest(BaseModel):
    focus_area: Optional[str] = None
    days: Optional[int] = 30
    max_feedback: Optional[int] = 200

class LLMAnalysisResponse(BaseModel):
    analysis: str
    key_themes: List[str]
    improvement_areas: List[dict]
    positive_highlights: List[str]
    actionable_recommendations: List[dict]
    feedback_analyzed_count: int
    generated_at: str


@router.get("/stats", response_model=FeedbackStats)
async def get_feedback_stats(
    admin: dict = Depends(require_admin)
):
    try:
        stats = await feedback_repo.get_feedback_stats()
        return FeedbackStats(**stats)
    except Exception as e:
        logger.error(f"Failed to get feedback stats: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve feedback stats")


@router.get("/sentiment", response_model=SentimentSummary)
async def get_sentiment_summary(
    admin: dict = Depends(require_admin)
):
    try:
        summary = await feedback_repo.get_sentiment_summary()
        return SentimentSummary(**summary)
    except Exception as e:
        logger.error(f"Failed to get sentiment summary: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve sentiment summary")


@router.get("/list")
async def list_feedback(
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(20, ge=1, le=100, description="Items per page"),
    rating_filter: Optional[float] = Query(None, description="Filter by rating"),
    has_text: Optional[bool] = Query(None, description="Filter by has feedback text"),
    sort_by: str = Query("created_at", description="Sort field"),
    sort_order: str = Query("desc", description="Sort order: asc, desc"),
    admin: dict = Depends(require_admin)
) -> PaginatedResponse[FeedbackWithUser]:
    try:
        feedback_list, total_count = await feedback_repo.list_feedback_paginated(
            page=page,
            page_size=page_size,
            rating_filter=rating_filter,
            has_text=has_text,
            sort_by=sort_by,
            sort_order=sort_order
        )
        
        pagination_params = PaginationParams(page=page, page_size=page_size)
        
        return await PaginationService.paginate_with_total_count(
            items=[FeedbackWithUser(**f) for f in feedback_list],
            total_count=total_count,
            params=pagination_params
        )
    except Exception as e:
        logger.error(f"Failed to list feedback: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to retrieve feedback")


@router.get("/export")
async def export_all_feedback(
    rating_filter: Optional[float] = Query(None, description="Filter by rating"),
    has_text: Optional[bool] = Query(None, description="Filter by has feedback text"),
    start_date: Optional[str] = Query(None, description="Start date (ISO format)"),
    end_date: Optional[str] = Query(None, description="End date (ISO format)"),
    admin: dict = Depends(require_admin)
) -> List[FeedbackWithUser]:
    try:
        start_dt = datetime.fromisoformat(start_date.replace('Z', '+00:00')) if start_date else None
        end_dt = datetime.fromisoformat(end_date.replace('Z', '+00:00')) if end_date else None
        
        feedback_list = await feedback_repo.get_all_feedback(
            rating_filter=rating_filter,
            has_text=has_text,
            start_date=start_dt,
            end_date=end_dt
        )
        
        return [FeedbackWithUser(**f) for f in feedback_list]
    except Exception as e:
        logger.error(f"Failed to export feedback: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to export feedback")


@router.get("/time-series", response_model=List[TimeSeriesPoint])
async def get_feedback_time_series(
    days: int = Query(30, ge=1, le=365, description="Number of days to look back"),
    granularity: str = Query("day", description="Granularity: day, week, month"),
    admin: dict = Depends(require_admin)
):
    try:
        data = await feedback_repo.get_feedback_time_series(days=days, granularity=granularity)
        return [TimeSeriesPoint(**d) for d in data]
    except Exception as e:
        logger.error(f"Failed to get feedback time series: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve time series data")


@router.get("/rating-trends", response_model=RatingTrends)
async def get_rating_trends(
    days: int = Query(30, ge=1, le=365, description="Number of days to look back"),
    admin: dict = Depends(require_admin)
):
    try:
        data = await feedback_repo.get_rating_trends(days=days)
        return RatingTrends(**data)
    except Exception as e:
        logger.error(f"Failed to get rating trends: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve rating trends")


@router.get("/critical", response_model=List[CriticalFeedback])
async def get_critical_feedback(
    limit: int = Query(20, ge=1, le=100, description="Number of items"),
    admin: dict = Depends(require_admin)
):
    try:
        data = await feedback_repo.get_critical_feedback(limit=limit)
        return [CriticalFeedback(**d) for d in data]
    except Exception as e:
        logger.error(f"Failed to get critical feedback: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve critical feedback")


@router.post("/analyze", response_model=LLMAnalysisResponse)
async def analyze_feedback_with_llm(
    request: LLMAnalysisRequest,
    admin: dict = Depends(require_admin)
):
    try:
        min_rating = None
        max_rating = None
        
        if request.focus_area == "negative":
            max_rating = 3.0
        elif request.focus_area == "positive":
            min_rating = 4.0
        elif request.focus_area == "critical":
            max_rating = 2.0
        
        feedback_list = await feedback_repo.get_feedback_for_analysis(
            limit=request.max_feedback or 200,
            min_rating=min_rating,
            max_rating=max_rating,
            only_with_text=True,
            days=request.days
        )
        
        if not feedback_list:
            return LLMAnalysisResponse(
                analysis="No feedback data available for analysis.",
                key_themes=[],
                improvement_areas=[],
                positive_highlights=[],
                actionable_recommendations=[],
                feedback_analyzed_count=0,
                generated_at=datetime.now(timezone.utc).isoformat()
            )
        
        feedback_texts = []
        for f in feedback_list:
            rating_emoji = "⭐" * int(f["rating"])
            text = f["feedback_text"] or ""
            feedback_texts.append(f"[Rating: {f['rating']}/5 {rating_emoji}] {text}")
        
        feedback_summary = "\n---\n".join(feedback_texts[:request.max_feedback or 200])
        
        sentiment = await feedback_repo.get_sentiment_summary()
        
        system_prompt = """You are an expert product analyst specializing in user feedback analysis. 
Your task is to analyze user feedback and provide SPECIFIC, ACTIONABLE insights that a product team can immediately act upon.

IMPORTANT GUIDELINES:
1. Be SPECIFIC - don't give generic advice like "improve user experience". Instead, identify exact issues mentioned.
2. Quote actual user feedback when relevant.
3. Prioritize issues by frequency and severity.
4. Provide concrete implementation suggestions.
5. Identify patterns across multiple feedback entries.
6. Distinguish between quick wins and larger initiatives.

Your response MUST be valid JSON with this exact structure:
{
  "analysis": "A comprehensive 2-3 paragraph analysis of the overall feedback sentiment and patterns",
  "key_themes": ["theme1", "theme2", "theme3", "theme4", "theme5"],
  "improvement_areas": [
    {
      "area": "Specific area name",
      "severity": "high|medium|low",
      "frequency": "Number of mentions or 'multiple'",
      "user_quotes": ["actual quote from feedback"],
      "suggested_action": "Specific action to take"
    }
  ],
  "positive_highlights": ["Specific positive thing users mentioned", "Another positive"],
  "actionable_recommendations": [
    {
      "recommendation": "Specific recommendation",
      "priority": "high|medium|low",
      "effort": "small|medium|large",
      "impact": "Description of expected impact",
      "implementation_hint": "How to implement this"
    }
  ]
}"""

        user_prompt = f"""Analyze the following {len(feedback_list)} user feedback entries.

CONTEXT:
- Total feedback in system: {sentiment['total']}
- Positive (4-5 stars): {sentiment['positive']} ({sentiment['positive_percentage']}%)
- Negative (1-2.5 stars): {sentiment['negative']} ({sentiment['negative_percentage']}%)
- Focus area: {request.focus_area or 'all feedback'}
- Time period: Last {request.days} days

FEEDBACK ENTRIES:
{feedback_summary}

Provide your analysis as valid JSON following the exact structure specified."""

        from core.services.llm import make_llm_api_call
        
        response = await make_llm_api_call(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            model_name="gpt-4o-mini",
            temperature=0.3,
            max_tokens=4000,
            stream=False
        )
        
        import json
        content = response.choices[0].message.content
        
        try:
            if "```json" in content:
                content = content.split("```json")[1].split("```")[0]
            elif "```" in content:
                content = content.split("```")[1].split("```")[0]
            
            analysis_data = json.loads(content.strip())
        except json.JSONDecodeError:
            logger.warning(f"Failed to parse LLM response as JSON: {content[:500]}")
            analysis_data = {
                "analysis": content,
                "key_themes": [],
                "improvement_areas": [],
                "positive_highlights": [],
                "actionable_recommendations": []
            }
        
        return LLMAnalysisResponse(
            analysis=analysis_data.get("analysis", ""),
            key_themes=analysis_data.get("key_themes", []),
            improvement_areas=analysis_data.get("improvement_areas", []),
            positive_highlights=analysis_data.get("positive_highlights", []),
            actionable_recommendations=analysis_data.get("actionable_recommendations", []),
            feedback_analyzed_count=len(feedback_list),
            generated_at=datetime.now(timezone.utc).isoformat()
        )
        
    except Exception as e:
        logger.error(f"Failed to analyze feedback with LLM: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to analyze feedback: {str(e)}")
