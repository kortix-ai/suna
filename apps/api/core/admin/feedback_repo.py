from typing import Dict, Any, Optional, List, Tuple
from datetime import datetime, timezone, timedelta
from core.services.db import execute, execute_one, serialize_row, serialize_rows
from core.utils.logger import logger


async def get_feedback_stats() -> Dict[str, Any]:
    sql = """
    SELECT 
        COUNT(*) as total_feedback,
        COALESCE(AVG(rating), 0) as average_rating,
        COUNT(*) FILTER (WHERE feedback_text IS NOT NULL AND feedback_text != '') as total_with_text
    FROM feedback
    """
    result = await execute_one(sql, {})
    
    if not result:
        return {
            "total_feedback": 0,
            "average_rating": 0.0,
            "total_with_text": 0,
            "rating_distribution": {}
        }
    
    dist_sql = """
    SELECT rating, COUNT(*) as count
    FROM feedback
    GROUP BY rating
    ORDER BY rating
    """
    dist_rows = await execute(dist_sql, {})
    
    rating_distribution = {}
    for r in [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0]:
        rating_distribution[str(r)] = 0
    
    if dist_rows:
        for row in dist_rows:
            rating_distribution[str(float(row["rating"]))] = row["count"]
    
    return {
        "total_feedback": result["total_feedback"] or 0,
        "average_rating": round(float(result["average_rating"] or 0), 2),
        "total_with_text": result["total_with_text"] or 0,
        "rating_distribution": rating_distribution
    }


async def list_feedback_paginated(
    page: int = 1,
    page_size: int = 20,
    rating_filter: Optional[float] = None,
    has_text: Optional[bool] = None,
    sort_by: str = "created_at",
    sort_order: str = "desc"
) -> Tuple[List[Dict[str, Any]], int]:
    offset = (page - 1) * page_size
    
    where_clauses = ["1=1"]
    params: Dict[str, Any] = {
        "limit": page_size,
        "offset": offset
    }
    
    if rating_filter is not None:
        where_clauses.append("f.rating = :rating_filter")
        params["rating_filter"] = rating_filter
    
    if has_text is True:
        where_clauses.append("f.feedback_text IS NOT NULL AND f.feedback_text != ''")
    elif has_text is False:
        where_clauses.append("(f.feedback_text IS NULL OR f.feedback_text = '')")
    
    where_sql = " AND ".join(where_clauses)
    
    valid_sort_columns = ["created_at", "rating", "updated_at"]
    if sort_by not in valid_sort_columns:
        sort_by = "created_at"
    
    order_direction = "DESC" if sort_order.lower() == "desc" else "ASC"
    
    sql = f"""
    WITH feedback_with_count AS (
        SELECT 
            f.*,
            COUNT(*) OVER() AS total_count
        FROM feedback f
        WHERE {where_sql}
        ORDER BY f.{sort_by} {order_direction}
        LIMIT :limit OFFSET :offset
    )
    SELECT 
        fwc.*,
        COALESCE(bc.email, 'N/A') as user_email
    FROM feedback_with_count fwc
    LEFT JOIN basejump.billing_customers bc ON fwc.account_id = bc.account_id
    """
    
    rows = await execute(sql, params)
    
    if not rows:
        return [], 0
    
    total_count = rows[0]["total_count"] if rows else 0
    
    feedback_list = []
    for row in rows:
        feedback_list.append({
            "feedback_id": str(row["feedback_id"]),
            "account_id": str(row["account_id"]) if row["account_id"] else None,
            "user_email": row["user_email"] or "N/A",
            "rating": float(row["rating"]),
            "feedback_text": row["feedback_text"],
            "help_improve": row["help_improve"],
            "thread_id": str(row["thread_id"]) if row["thread_id"] else None,
            "message_id": str(row["message_id"]) if row["message_id"] else None,
            "context": row["context"],
            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
            "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None
        })
    
    return feedback_list, total_count


async def get_all_feedback(
    rating_filter: Optional[float] = None,
    has_text: Optional[bool] = None,
    start_date: Optional[datetime] = None,
    end_date: Optional[datetime] = None
) -> List[Dict[str, Any]]:
    where_clauses = ["1=1"]
    params: Dict[str, Any] = {}
    
    if rating_filter is not None:
        where_clauses.append("f.rating = :rating_filter")
        params["rating_filter"] = rating_filter
    
    if has_text is True:
        where_clauses.append("f.feedback_text IS NOT NULL AND f.feedback_text != ''")
    elif has_text is False:
        where_clauses.append("(f.feedback_text IS NULL OR f.feedback_text = '')")
    
    if start_date:
        where_clauses.append("f.created_at >= :start_date")
        params["start_date"] = start_date
    
    if end_date:
        where_clauses.append("f.created_at <= :end_date")
        params["end_date"] = end_date
    
    where_sql = " AND ".join(where_clauses)
    
    sql = f"""
    SELECT 
        f.*,
        COALESCE(bc.email, 'N/A') as user_email
    FROM feedback f
    LEFT JOIN basejump.billing_customers bc ON f.account_id = bc.account_id
    WHERE {where_sql}
    ORDER BY f.created_at DESC
    """
    
    rows = await execute(sql, params)
    
    if not rows:
        return []
    
    return [
        {
            "feedback_id": str(row["feedback_id"]),
            "account_id": str(row["account_id"]) if row["account_id"] else None,
            "user_email": row["user_email"] or "N/A",
            "rating": float(row["rating"]),
            "feedback_text": row["feedback_text"],
            "help_improve": row["help_improve"],
            "thread_id": str(row["thread_id"]) if row["thread_id"] else None,
            "message_id": str(row["message_id"]) if row["message_id"] else None,
            "context": row["context"],
            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
            "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None
        }
        for row in rows
    ]


async def get_feedback_time_series(
    days: int = 30,
    granularity: str = "day"
) -> List[Dict[str, Any]]:
    start_date = datetime.now(timezone.utc) - timedelta(days=days)
    
    if granularity == "week":
        date_trunc = "week"
    elif granularity == "month":
        date_trunc = "month"
    else:
        date_trunc = "day"
    
    sql = f"""
    SELECT 
        DATE_TRUNC(:date_trunc, created_at) as period,
        COUNT(*) as count,
        COALESCE(AVG(rating), 0) as avg_rating,
        COUNT(*) FILTER (WHERE rating >= 4.0) as positive_count,
        COUNT(*) FILTER (WHERE rating < 3.0) as negative_count,
        COUNT(*) FILTER (WHERE feedback_text IS NOT NULL AND feedback_text != '') as with_text_count
    FROM feedback
    WHERE created_at >= :start_date
    GROUP BY DATE_TRUNC(:date_trunc, created_at)
    ORDER BY period ASC
    """
    
    rows = await execute(sql, {
        "date_trunc": date_trunc,
        "start_date": start_date
    })
    
    if not rows:
        return []
    
    return [
        {
            "period": row["period"].isoformat() if row["period"] else None,
            "count": row["count"],
            "avg_rating": round(float(row["avg_rating"] or 0), 2),
            "positive_count": row["positive_count"],
            "negative_count": row["negative_count"],
            "with_text_count": row["with_text_count"]
        }
        for row in rows
    ]


async def get_rating_trends(days: int = 30) -> Dict[str, Any]:
    start_date = datetime.now(timezone.utc) - timedelta(days=days)
    
    sql = """
    SELECT 
        DATE_TRUNC('day', created_at) as period,
        rating,
        COUNT(*) as count
    FROM feedback
    WHERE created_at >= :start_date
    GROUP BY DATE_TRUNC('day', created_at), rating
    ORDER BY period ASC, rating ASC
    """
    
    rows = await execute(sql, {"start_date": start_date})
    
    if not rows:
        return {"periods": [], "data": {}}
    
    periods_set = set()
    data_by_rating: Dict[str, Dict[str, int]] = {}
    
    for row in rows:
        period = row["period"].isoformat() if row["period"] else None
        rating = str(float(row["rating"]))
        count = row["count"]
        
        periods_set.add(period)
        
        if rating not in data_by_rating:
            data_by_rating[rating] = {}
        data_by_rating[rating][period] = count
    
    periods = sorted(list(periods_set))
    
    return {
        "periods": periods,
        "data": data_by_rating
    }

async def get_feedback_for_analysis(
    limit: int = 500,
    min_rating: Optional[float] = None,
    max_rating: Optional[float] = None,
    only_with_text: bool = True,
    days: Optional[int] = None
) -> List[Dict[str, Any]]:
    where_clauses = []
    params: Dict[str, Any] = {"limit": limit}
    
    if only_with_text:
        where_clauses.append("feedback_text IS NOT NULL AND feedback_text != ''")
    
    if min_rating is not None:
        where_clauses.append("rating >= :min_rating")
        params["min_rating"] = min_rating
    
    if max_rating is not None:
        where_clauses.append("rating <= :max_rating")
        params["max_rating"] = max_rating
    
    if days:
        where_clauses.append("created_at >= :start_date")
        params["start_date"] = datetime.now(timezone.utc) - timedelta(days=days)
    
    where_sql = " AND ".join(where_clauses) if where_clauses else "1=1"
    
    sql = f"""
    SELECT 
        feedback_id,
        rating,
        feedback_text,
        context,
        created_at
    FROM feedback
    WHERE {where_sql}
    ORDER BY created_at DESC
    LIMIT :limit
    """
    
    rows = await execute(sql, params)
    
    if not rows:
        return []
    
    return [
        {
            "feedback_id": str(row["feedback_id"]),
            "rating": float(row["rating"]),
            "feedback_text": row["feedback_text"],
            "context": row["context"],
            "created_at": row["created_at"].isoformat() if row["created_at"] else None
        }
        for row in rows
    ]

async def get_sentiment_summary() -> Dict[str, Any]:
    sql = """
    SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE rating >= 4.0) as positive,
        COUNT(*) FILTER (WHERE rating >= 3.0 AND rating < 4.0) as neutral,
        COUNT(*) FILTER (WHERE rating < 3.0) as negative,
        COUNT(*) FILTER (WHERE rating = 5.0) as five_star,
        COUNT(*) FILTER (WHERE rating <= 2.0) as critical
    FROM feedback
    """
    result = await execute_one(sql, {})
    
    if not result:
        return {
            "total": 0,
            "positive": 0,
            "neutral": 0,
            "negative": 0,
            "five_star": 0,
            "critical": 0,
            "positive_percentage": 0,
            "negative_percentage": 0
        }
    
    total = result["total"] or 1
    
    return {
        "total": result["total"] or 0,
        "positive": result["positive"] or 0,
        "neutral": result["neutral"] or 0,
        "negative": result["negative"] or 0,
        "five_star": result["five_star"] or 0,
        "critical": result["critical"] or 0,
        "positive_percentage": round((result["positive"] or 0) / total * 100, 1),
        "negative_percentage": round((result["negative"] or 0) / total * 100, 1)
    }


async def get_critical_feedback(limit: int = 20) -> List[Dict[str, Any]]:
    sql = """
    SELECT 
        f.feedback_id,
        f.rating,
        f.feedback_text,
        f.created_at,
        f.thread_id,
        COALESCE(bc.email, 'N/A') as user_email
    FROM feedback f
    LEFT JOIN basejump.billing_customers bc ON f.account_id = bc.account_id
    WHERE f.rating <= 2.5 
      AND f.feedback_text IS NOT NULL 
      AND f.feedback_text != ''
    ORDER BY f.created_at DESC
    LIMIT :limit
    """
    
    rows = await execute(sql, {"limit": limit})
    
    if not rows:
        return []
    
    return [
        {
            "feedback_id": str(row["feedback_id"]),
            "rating": float(row["rating"]),
            "feedback_text": row["feedback_text"],
            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
            "thread_id": str(row["thread_id"]) if row["thread_id"] else None,
            "user_email": row["user_email"] or "N/A"
        }
        for row in rows
    ]
