from __future__ import annotations
import base64
import io
from typing import Any, Dict, List, Optional, Tuple
from .async_parser import ImageAnalysisResult


class ImageAnalyzer:
    __slots__ = ("_api_key", "_model", "_max_tokens", "_timeout")
    
    def __init__(
        self,
        api_key: Optional[str] = None,
        model: str = "gpt-4o-mini",
        max_tokens: int = 500,
        timeout: float = 30.0,
    ):
        self._api_key = api_key
        self._model = model
        self._max_tokens = max_tokens
        self._timeout = timeout
    
    async def analyze(
        self,
        image_bytes: bytes,
        filename: str,
        mime_type: str,
        prompt: Optional[str] = None,
    ) -> ImageAnalysisResult:
        if not self._api_key:
            return ImageAnalysisResult(
                success=False,
                description="",
                error="No API key configured for image analysis",
            )
        
        try:
            from core.services.llm import make_llm_api_call
        except ImportError:
            return await self._fallback_analyze(image_bytes, filename, mime_type)
        
        try:
            base64_image = base64.b64encode(image_bytes).decode("utf-8")
            
            data_url = f"data:{mime_type};base64,{base64_image}"
            
            analysis_prompt = prompt or """Analyze this image and provide:
1. A brief description of what the image shows
2. Key visual elements or objects present
3. Any text visible in the image
4. The overall context or purpose of the image

Be concise but comprehensive."""
            
            messages = [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": analysis_prompt},
                        {"type": "image_url", "image_url": {"url": data_url}},
                    ],
                }
            ]
            
            response = await make_llm_api_call(
                messages=messages,
                model_name=self._model,
                max_tokens=self._max_tokens,
                temperature=0.1,
            )
            
            description = response.choices[0].message.content.strip()
            
            labels = self._extract_labels(description)
            text_content = self._extract_text_content(description)
            
            return ImageAnalysisResult(
                success=True,
                description=description,
                labels=labels,
                text_content=text_content,
                metadata={
                    "model": self._model,
                    "filename": filename,
                    "mime_type": mime_type,
                },
            )
            
        except Exception as e:
            return ImageAnalysisResult(
                success=False,
                description="",
                error=f"Image analysis failed: {str(e)}",
            )
    
    async def _fallback_analyze(
        self,
        image_bytes: bytes,
        filename: str,
        mime_type: str,
    ) -> ImageAnalysisResult:
        try:
            from PIL import Image
            
            img = Image.open(io.BytesIO(image_bytes))
            
            description = f"Image file: {filename}\n"
            description += f"Dimensions: {img.width}x{img.height} pixels\n"
            description += f"Format: {img.format or mime_type}\n"
            description += f"Mode: {img.mode}\n"
            
            if img.mode == "P":
                description += "Type: Indexed color / palette image\n"
            elif img.mode == "RGBA":
                description += "Type: Color image with transparency\n"
            elif img.mode == "RGB":
                description += "Type: Color image\n"
            elif img.mode == "L":
                description += "Type: Grayscale image\n"
            elif img.mode == "1":
                description += "Type: Black and white image\n"
            
            return ImageAnalysisResult(
                success=True,
                description=description,
                labels=["image"],
                metadata={
                    "width": img.width,
                    "height": img.height,
                    "format": img.format,
                    "mode": img.mode,
                },
            )
            
        except Exception as e:
            return ImageAnalysisResult(
                success=False,
                description="",
                error=f"Fallback analysis failed: {str(e)}",
            )
    
    def _extract_labels(self, description: str) -> List[str]:
        labels = []
        
        common_objects = [
            "person", "people", "face", "portrait",
            "landscape", "nature", "tree", "flower", "animal",
            "building", "architecture", "city", "street",
            "car", "vehicle", "road",
            "food", "drink",
            "text", "document", "chart", "graph", "diagram",
            "logo", "icon", "screenshot",
            "photo", "illustration", "drawing", "art",
        ]
        
        desc_lower = description.lower()
        for obj in common_objects:
            if obj in desc_lower:
                labels.append(obj)
        
        return labels[:10]
    
    def _extract_text_content(self, description: str) -> str:
        lines = description.split("\n")
        text_lines = []
        capture = False
        
        for line in lines:
            line_lower = line.lower()
            if any(kw in line_lower for kw in ["text visible", "text in image", "text reads", "text says"]):
                capture = True
                continue
            if capture:
                if line.strip() and not line.startswith(("1.", "2.", "3.", "4.", "-", "*")):
                    text_lines.append(line.strip())
                elif not line.strip():
                    capture = False
        
        return "\n".join(text_lines)
    
    def __call__(
        self,
        image_bytes: bytes,
        filename: str,
        mime_type: str,
    ) -> ImageAnalysisResult:
        import asyncio
        
        try:
            loop = asyncio.get_event_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
        
        return loop.run_until_complete(self.analyze(image_bytes, filename, mime_type))


def create_image_analyzer(
    api_key: Optional[str] = None,
    model: str = "gpt-4o-mini",
) -> ImageAnalyzer:
    if api_key is None:
        try:
            from core.utils.config import config
            api_key = config.OPENAI_API_KEY
        except ImportError:
            pass
    
    return ImageAnalyzer(api_key=api_key, model=model)
