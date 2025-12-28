from fastapi import APIRouter, HTTPException, Depends, Query
from typing import Optional, List
from datetime import datetime
from pydantic import BaseModel
from core.auth import require_admin
from core.services.supabase import DBConnection
from core.utils.logger import logger
from core.utils.pagination import PaginationService, PaginationParams, PaginatedResponse

router = APIRouter(prefix="/admin/feedback", tags=["admin", "feedback"])

class FeedbackWithUser(BaseModel):
    feedback_id: str
    account_id: str
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

@router.get("/stats")
async def get_feedback_stats(
    admin: dict = Depends(require_admin)
):
    try:
        db = DBConnection()
        client = await db.client
        
        feedback_result = await client.from_('feedback').select('rating, feedback_text').execute()
        
        if not feedback_result.data:
            return FeedbackStats(
                total_feedback=0,
                average_rating=0.0,
                total_with_text=0,
                rating_distribution={}
            )
        
        total_feedback = len(feedback_result.data)
        ratings = [f['rating'] for f in feedback_result.data]
        average_rating = sum(ratings) / len(ratings) if ratings else 0.0
        total_with_text = sum(1 for f in feedback_result.data if f.get('feedback_text'))
        
        rating_distribution = {}
        for rating in [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0]:
            rating_distribution[str(rating)] = sum(1 for r in ratings if r == rating)
        
        return FeedbackStats(
            total_feedback=total_feedback,
            average_rating=round(average_rating, 2),
            total_with_text=total_with_text,
            rating_distribution=rating_distribution
        )
        
    except Exception as e:
        logger.error(f"Failed to get feedback stats: {e}")
        raise HTTPException(status_code=500, detail="Failed to retrieve feedback stats")

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
        db = DBConnection()
        client = await db.client
        
        pagination_params = PaginationParams(page=page, page_size=page_size)
        
        count_query = client.from_('feedback').select('*', count='exact')
        data_query = client.from_('feedback').select('*')
        
        if rating_filter is not None:
            count_query = count_query.eq('rating', rating_filter)
            data_query = data_query.eq('rating', rating_filter)
        
        if has_text is not None:
            if has_text:
                count_query = count_query.not_.is_('feedback_text', 'null')
                data_query = data_query.not_.is_('feedback_text', 'null')
            else:
                count_query = count_query.is_('feedback_text', 'null')
                data_query = data_query.is_('feedback_text', 'null')
        
        count_result = await count_query.execute()
        total_count = count_result.count or 0
        
        ascending = sort_order.lower() == "asc"
        data_query = data_query.order(sort_by, desc=not ascending)
        
        offset = (pagination_params.page - 1) * pagination_params.page_size
        data_result = await data_query.range(
            offset, offset + pagination_params.page_size - 1
        ).execute()
        
        account_ids = list(set(f.get('account_id') for f in data_result.data or [] if f.get('account_id')))
        email_map = {}
        
        if account_ids:
            try:
                billing_result = await client.schema('basejump').from_('billing_customers').select('account_id, email').in_('account_id', account_ids).execute()
                for row in billing_result.data or []:
                    if row.get('email'):
                        email_map[row['account_id']] = row['email']
                
                missing_account_ids = [aid for aid in account_ids if aid not in email_map]
                if missing_account_ids:
                    accounts_result = await client.schema('basejump').from_('accounts').select('id, primary_owner_user_id').in_('id', missing_account_ids).execute()
                    user_ids = []
                    user_id_to_account = {}
                    for row in accounts_result.data or []:
                        user_id = row.get('primary_owner_user_id')
                        if user_id:
                            user_ids.append(user_id)
                            user_id_to_account[user_id] = row['id']
                    
                    if user_ids:
                        for user_id in user_ids:
                            try:
                                email_result = await client.rpc('get_user_email', {'user_id': user_id}).execute()
                                if email_result.data:
                                    email_map[user_id_to_account[user_id]] = email_result.data
                            except Exception as e:
                                logger.warning(f"Failed to get email for user {user_id}: {e}")
            except Exception as e:
                logger.warning(f"Failed to batch fetch emails: {e}")
        
        feedback_list = []
        for feedback in data_result.data or []:
            account_id = feedback.get('account_id')
            user_email = email_map.get(account_id, 'N/A') if account_id else 'N/A'
            
            feedback_list.append(FeedbackWithUser(
                feedback_id=feedback['feedback_id'],
                account_id=account_id,
                user_email=user_email,
                rating=float(feedback['rating']),
                feedback_text=feedback.get('feedback_text'),
                help_improve=feedback.get('help_improve', True),
                thread_id=feedback.get('thread_id'),
                message_id=feedback.get('message_id'),
                context=feedback.get('context'),
                created_at=feedback['created_at'],
                updated_at=feedback['updated_at']
            ))
        
        return await PaginationService.paginate_with_total_count(
            items=feedback_list,
            total_count=total_count,
            params=pagination_params
        )
        
    except Exception as e:
        logger.error(f"Failed to list feedback: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to retrieve feedback")

