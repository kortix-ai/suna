import uuid
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, HTTPException, Depends, Body
from pydantic import BaseModel

from core.utils.auth_utils import verify_and_get_user_id_from_jwt
from core.utils.logger import logger
from . import core_utils as utils

router = APIRouter(tags=["feedback"])


class FeedbackRequest(BaseModel):
    """Request model for submitting feedback."""
    rating: float
    feedback_text: Optional[str] = None
    help_improve: bool = True
    thread_id: Optional[str] = None  # Optional - feedback can be standalone
    message_id: Optional[str] = None  # Optional - feedback can be standalone
    context: Optional[dict] = None  # Additional context/metadata


class FeedbackResponse(BaseModel):
    """Response model for feedback."""
    feedback_id: str
    thread_id: Optional[str] = None
    message_id: Optional[str] = None
    account_id: str
    rating: float
    feedback_text: Optional[str] = None
    help_improve: bool
    context: Optional[dict] = None
    created_at: str
    updated_at: str


@router.post("/feedback", response_model=FeedbackResponse, summary="Submit Feedback", operation_id="submit_feedback")
async def submit_feedback(
    feedback_data: FeedbackRequest,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Submit feedback (rating and optional text). Can be associated with a thread/message or standalone."""
    logger.debug(f"Submitting feedback from user {user_id}")
    client = await utils.db.client
    
    try:
        # Validate rating (0.5 to 5.0 in 0.5 increments)
        if feedback_data.rating < 0.5 or feedback_data.rating > 5.0:
            raise HTTPException(status_code=400, detail="Rating must be between 0.5 and 5.0")
        if (feedback_data.rating * 2) % 1 != 0:
            raise HTTPException(status_code=400, detail="Rating must be in 0.5 increments")
        
        # If thread_id and message_id are provided, verify they exist and user has access
        if feedback_data.thread_id:
            from core.utils.auth_utils import verify_and_authorize_thread_access
            await verify_and_authorize_thread_access(client, feedback_data.thread_id, user_id)
            
            if feedback_data.message_id:
                # Verify message exists and belongs to thread
                message_result = await client.table('messages').select('message_id').eq('message_id', feedback_data.message_id).eq('thread_id', feedback_data.thread_id).execute()
                if not message_result.data:
                    raise HTTPException(status_code=404, detail="Message not found in thread")
        
        # Check if feedback already exists (for thread_id + message_id combination)
        existing_feedback = None
        if feedback_data.thread_id and feedback_data.message_id:
            existing_feedback_result = await client.table('feedback').select('*').eq('thread_id', feedback_data.thread_id).eq('message_id', feedback_data.message_id).eq('account_id', user_id).execute()
            if existing_feedback_result.data:
                existing_feedback = existing_feedback_result.data[0]
        
        feedback_payload = {
            "account_id": user_id,
            "rating": float(feedback_data.rating),
            "feedback_text": feedback_data.feedback_text,
            "help_improve": feedback_data.help_improve,
            "updated_at": datetime.now(timezone.utc).isoformat()
        }
        
        # Add optional fields
        if feedback_data.thread_id:
            feedback_payload["thread_id"] = feedback_data.thread_id
        if feedback_data.message_id:
            feedback_payload["message_id"] = feedback_data.message_id
        if feedback_data.context:
            feedback_payload["context"] = feedback_data.context
        
        if existing_feedback:
            # Update existing feedback
            feedback_result = await client.table('feedback').update(feedback_payload).eq('feedback_id', existing_feedback['feedback_id']).execute()
            if not feedback_result.data:
                raise HTTPException(status_code=500, detail="Failed to update feedback")
            logger.debug(f"Updated feedback {feedback_result.data[0]['feedback_id']}")
            return feedback_result.data[0]
        else:
            # Insert new feedback
            feedback_payload["feedback_id"] = str(uuid.uuid4())
            feedback_payload["created_at"] = datetime.now(timezone.utc).isoformat()
            feedback_result = await client.table('feedback').insert(feedback_payload).execute()
            if not feedback_result.data:
                raise HTTPException(status_code=500, detail="Failed to create feedback")
            logger.debug(f"Created feedback {feedback_result.data[0]['feedback_id']}")
            return feedback_result.data[0]
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error submitting feedback: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to submit feedback: {str(e)}")


@router.get("/feedback", response_model=list[FeedbackResponse], summary="Get Feedback", operation_id="get_feedback")
async def get_feedback(
    thread_id: Optional[str] = None,
    message_id: Optional[str] = None,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Get feedback. Can filter by thread_id and/or message_id. Returns user's own feedback."""
    logger.debug(f"Getting feedback for user {user_id}")
    client = await utils.db.client
    
    try:
        query = client.table('feedback').select('*').eq('account_id', user_id)
        
        if thread_id:
            # Verify thread access
            from core.utils.auth_utils import verify_and_authorize_thread_access
            await verify_and_authorize_thread_access(client, thread_id, user_id)
            query = query.eq('thread_id', thread_id)
        
        if message_id:
            query = query.eq('message_id', message_id)
        
        feedback_result = await query.execute()
        
        return feedback_result.data or []
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting feedback: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to get feedback: {str(e)}")


@router.get("/feedback/{feedback_id}", response_model=Optional[FeedbackResponse], summary="Get Feedback by ID", operation_id="get_feedback_by_id")
async def get_feedback_by_id(
    feedback_id: str,
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Get a specific feedback by ID (only if it belongs to the current user)."""
    logger.debug(f"Getting feedback {feedback_id} for user {user_id}")
    client = await utils.db.client
    
    try:
        feedback_result = await client.table('feedback').select('*').eq('feedback_id', feedback_id).eq('account_id', user_id).execute()
        
        if not feedback_result.data:
            return None
        
        return feedback_result.data[0]
        
    except Exception as e:
        logger.error(f"Error getting feedback {feedback_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to get feedback: {str(e)}")

