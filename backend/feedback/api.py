from pydantic import BaseModel, Field
from fastapi import APIRouter, HTTPException
from services.supabase import DBConnection

router = APIRouter(prefix="/feedback", tags=["feedback"])

class FeedbackRequest(BaseModel):
    message_id: str = Field(..., description="ID of the message that is being rated")
    is_good: bool = Field(..., description="True for good response, False for bad response")
    feedback: str | None = Field(None, description="Optional free-form text feedback from the user")

db = DBConnection()
@router.post("/")
async def submit_feedback(request: FeedbackRequest):
    try:
        client = await db.client

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
