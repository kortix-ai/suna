import os
import logging
from typing import Dict, Any
from openai import OpenAI

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

api_key = os.getenv("OPENAI_API_KEY")
if not api_key:
    logger.error("No OpenAI API key found. Set OPENAI_API_KEY environment variable.")
    raise ValueError("OPENAI_API_KEY environment variable is required")

client = OpenAI(api_key=api_key)

async def get_embedding(text: str, model: str) -> Dict[str, Any]:
    try:
        response = client.embeddings.create(
            input=text,
            model=model
        )
        return response
    except Exception as e:
        logger.error(f"Error calling OpenAI embeddings API: {e}")
        raise