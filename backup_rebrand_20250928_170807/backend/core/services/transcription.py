import os
import openai
import tempfile
from fastapi import APIRouter, UploadFile, File, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional
from core.utils.logger import logger
from core.utils.auth_utils import verify_and_get_user_id_from_jwt

router = APIRouter(tags=["transcription"])

class TranscriptionResponse(BaseModel):
    text: str

@router.post("/transcription", response_model=TranscriptionResponse)
async def transcribe_audio(
    audio_file: UploadFile = File(...),
    user_id: str = Depends(verify_and_get_user_id_from_jwt)
):
    """Transcribe audio file to text using OpenAI Whisper."""
    try:
        # Validate file type - OpenAI supports these formats
        allowed_types = [
            'audio/mp3', 'audio/mpeg', 'audio/mp4', 'audio/m4a', 
            'audio/wav', 'audio/webm', 'audio/mpga'
        ]
        
        logger.debug(f"Received audio file: {audio_file.filename}, content_type: {audio_file.content_type}")
        
        if audio_file.content_type not in allowed_types:
            raise HTTPException(
                status_code=400, 
                detail=f"Unsupported file type: {audio_file.content_type}. Supported types: {', '.join(allowed_types)}"
            )
        
        # Check file size (25MB limit)
        content = await audio_file.read()
        if len(content) > 25 * 1024 * 1024:  # 25MB
            raise HTTPException(status_code=400, detail="File size exceeds 25MB limit")
        
        # Reset file pointer
        await audio_file.seek(0)
        
        # Initialize OpenAI client
        client = openai.OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
        
        # Create a temporary file with the correct extension
        file_extension = audio_file.filename.split('.')[-1] if audio_file.filename and '.' in audio_file.filename else 'webm'
        
        with tempfile.NamedTemporaryFile(delete=False, suffix=f'.{file_extension}') as temp_file:
            temp_file.write(content)
            temp_file_path = temp_file.name
        
        try:
            # Transcribe audio using the temporary file
            # OpenAI Whisper API has built-in limits: 25MB file size and handles duration limits internally
            with open(temp_file_path, 'rb') as f:
                transcription = client.audio.transcriptions.create(
                    model="gpt-4o-mini-transcribe",
                    file=f,
                    response_format="text"
                )
            
            logger.debug(f"Successfully transcribed audio for user {user_id}")
            return TranscriptionResponse(text=transcription)
            
        finally:
            # Clean up temporary file
            try:
                os.unlink(temp_file_path)
            except Exception as e:
                logger.warning(f"Failed to delete temporary file {temp_file_path}: {e}")
        
    except Exception as e:
        logger.error(f"Error transcribing audio for user {user_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}") 