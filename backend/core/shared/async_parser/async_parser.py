from __future__ import annotations
import asyncio
import base64
import io
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Union, BinaryIO, Callable

from .parser import FastParse, ParseResult, ParseError, FileType
from .config import FastParseConfig, DEFAULT_CONFIG


@dataclass
class ImageAnalysisResult:
    success: bool
    description: str
    labels: List[str] = field(default_factory=list)
    text_content: str = ""
    metadata: Dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None


class AsyncFastParse:
    __slots__ = ("_sync_parser", "_config", "_executor", "_image_analyzer")
    
    def __init__(
        self,
        config: Optional[FastParseConfig] = None,
        max_workers: int = 4,
        image_analyzer: Optional[Callable] = None,
    ):
        self._config = config or DEFAULT_CONFIG
        self._sync_parser = FastParse(self._config)
        self._executor = ThreadPoolExecutor(max_workers=max_workers)
        self._image_analyzer = image_analyzer
    
    def set_image_analyzer(self, analyzer: Callable) -> None:
        self._image_analyzer = analyzer
    
    async def parse(
        self,
        content: Union[bytes, BinaryIO, str],
        filename: str,
        mime_type: Optional[str] = None,
        analyze_images: bool = False,
    ) -> ParseResult:
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            self._executor,
            lambda: self._sync_parser.parse(content, filename, mime_type)
        )
        
        if analyze_images and result.file_type == FileType.IMAGE and result.success:
            if self._image_analyzer:
                try:
                    if isinstance(content, str):
                        image_bytes = content.encode("utf-8")
                    elif hasattr(content, "read"):
                        content.seek(0)
                        image_bytes = content.read()
                    else:
                        image_bytes = content
                    
                    analysis = await self._analyze_image(image_bytes, filename, result.mime_type)
                    
                    if analysis.success:
                        result.content = f"[Image: {filename}]\n\n"
                        result.content += f"Description: {analysis.description}\n\n"
                        if analysis.labels:
                            result.content += f"Labels: {', '.join(analysis.labels)}\n\n"
                        if analysis.text_content:
                            result.content += f"Text in image:\n{analysis.text_content}\n\n"
                        result.metadata["image_analysis"] = {
                            "description": analysis.description,
                            "labels": analysis.labels,
                            "text_content": analysis.text_content,
                        }
                except Exception as e:
                    result.warnings.append(f"Image analysis failed: {str(e)}")
        
        return result
    
    async def parse_file(
        self,
        file_path: Union[str, Path],
        analyze_images: bool = False,
    ) -> ParseResult:
        path = Path(file_path)
        
        if not path.exists():
            return ParseResult(
                success=False,
                content="",
                file_type=FileType.UNKNOWN,
                filename=path.name,
                mime_type="application/octet-stream",
                file_size=0,
                error=f"File not found: {file_path}",
            )
        
        file_size = path.stat().st_size
        if file_size > self._config.max_file_size_bytes:
            return ParseResult(
                success=False,
                content="",
                file_type=FileType.UNKNOWN,
                filename=path.name,
                mime_type="application/octet-stream",
                file_size=file_size,
                error=f"File exceeds maximum size limit of {self._config.max_file_size_bytes / (1024*1024):.1f}MB",
            )
        
        loop = asyncio.get_event_loop()
        content = await loop.run_in_executor(
            self._executor,
            lambda: path.read_bytes()
        )
        
        return await self.parse(content, path.name, analyze_images=analyze_images)
    
    async def parse_multiple(
        self,
        files: List[Dict[str, Any]],
        analyze_images: bool = False,
    ) -> List[ParseResult]:
        tasks = []
        for file_info in files:
            if "path" in file_info:
                tasks.append(self.parse_file(file_info["path"], analyze_images))
            elif "content" in file_info and "filename" in file_info:
                tasks.append(self.parse(
                    file_info["content"],
                    file_info["filename"],
                    file_info.get("mime_type"),
                    analyze_images,
                ))
        
        return await asyncio.gather(*tasks, return_exceptions=False)
    
    async def _analyze_image(
        self,
        image_bytes: bytes,
        filename: str,
        mime_type: str,
    ) -> ImageAnalysisResult:
        if not self._image_analyzer:
            return ImageAnalysisResult(
                success=False,
                description="",
                error="No image analyzer configured",
            )
        
        try:
            if asyncio.iscoroutinefunction(self._image_analyzer):
                result = await self._image_analyzer(image_bytes, filename, mime_type)
            else:
                loop = asyncio.get_event_loop()
                result = await loop.run_in_executor(
                    self._executor,
                    lambda: self._image_analyzer(image_bytes, filename, mime_type)
                )
            
            if isinstance(result, ImageAnalysisResult):
                return result
            elif isinstance(result, dict):
                return ImageAnalysisResult(
                    success=True,
                    description=result.get("description", ""),
                    labels=result.get("labels", []),
                    text_content=result.get("text_content", ""),
                    metadata=result.get("metadata", {}),
                )
            elif isinstance(result, str):
                return ImageAnalysisResult(
                    success=True,
                    description=result,
                )
            else:
                return ImageAnalysisResult(
                    success=False,
                    description="",
                    error="Invalid analyzer response format",
                )
        except asyncio.TimeoutError:
            return ImageAnalysisResult(
                success=False,
                description="",
                error="Image analysis timed out",
            )
        except Exception as e:
            return ImageAnalysisResult(
                success=False,
                description="",
                error=f"Image analysis failed: {str(e)}",
            )
    
    def detect_file_type(self, filename: str, mime_type: Optional[str] = None) -> FileType:
        return self._sync_parser.detect_file_type(filename, mime_type)
    
    async def close(self) -> None:
        self._executor.shutdown(wait=False)
    
    async def __aenter__(self) -> "AsyncFastParse":
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        await self.close()


_default_async_parser: Optional[AsyncFastParse] = None


def get_async_parser(
    config: Optional[FastParseConfig] = None,
    image_analyzer: Optional[Callable] = None,
) -> AsyncFastParse:
    global _default_async_parser
    if config is not None or image_analyzer is not None:
        return AsyncFastParse(config, image_analyzer=image_analyzer)
    if _default_async_parser is None:
        _default_async_parser = AsyncFastParse()
    return _default_async_parser


async def async_parse(
    content: Union[bytes, BinaryIO, str],
    filename: str,
    mime_type: Optional[str] = None,
    analyze_images: bool = False,
    config: Optional[FastParseConfig] = None,
) -> ParseResult:
    return await get_async_parser(config).parse(content, filename, mime_type, analyze_images)


async def async_parse_file(
    file_path: Union[str, Path],
    analyze_images: bool = False,
    config: Optional[FastParseConfig] = None,
) -> ParseResult:
    return await get_async_parser(config).parse_file(file_path, analyze_images)

