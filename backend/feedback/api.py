from pydantic import BaseModel, Field
from fastapi import APIRouter, Depends, HTTPException
from services.supabase import DBConnection
from utils.auth_utils import get_current_user_id_from_jwt, verify_thread_access

router = APIRouter(prefix="/feedback", tags=["feedback"])

class FeedbackRequest(BaseModel):
    message_id: str = Field(..., description="ID of the message that is being rated")
    is_good: bool = Field(..., description="True for good response, False for bad response")
    feedback: str | None = Field(None, description="Optional free-form text feedback from the user")

db = DBConnection()
@router.post("/")
async def submit_feedback(request: FeedbackRequest, user_id: str = Depends(get_current_user_id_from_jwt)):
    try:
        client = await db.client
        thread = await client.table('messages').select('thread_id').eq('message_id', request.message_id).single().execute()

        if not thread.data:
            raise HTTPException(status_code=404, detail="Message not found")
        
        thread_id = thread.data['thread_id']

        await verify_thread_access(client, thread_id, user_id)
        
        feedback_data = {
            'message_id': request.message_id,
            'is_good': request.is_good,
            'feedback': request.feedback
        }

        feedback_result = await client.table('feedback').insert(feedback_data).execute()

        if not feedback_result.data:
            raise HTTPException(status_code=500, detail="Failed to submit feedback")

        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
