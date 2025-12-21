from __future__ import annotations
from typing import Any, Dict, Optional


class FastParseError(Exception):
    def __init__(
        self,
        message: str,
        error_code: str = "FAST_PARSE_ERROR",
        details: Optional[Dict[str, Any]] = None,
        recoverable: bool = True,
    ):
        super().__init__(message)
        self.message = message
        self.error_code = error_code
        self.details = details or {}
        self.recoverable = recoverable
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "error": self.error_code,
            "message": self.message,
            "details": self.details,
            "recoverable": self.recoverable,
        }


class FileSizeExceededError(FastParseError):
    def __init__(self, file_size: int, max_size: int, filename: str = ""):
        super().__init__(
            message=f"File size ({file_size:,} bytes) exceeds maximum allowed ({max_size:,} bytes)",
            error_code="FILE_SIZE_EXCEEDED",
            details={
                "file_size": file_size,
                "max_size": max_size,
                "filename": filename,
            },
            recoverable=False,
        )


class UnsupportedFormatError(FastParseError):
    def __init__(self, extension: str, mime_type: Optional[str] = None):
        super().__init__(
            message=f"Unsupported file format: {extension}",
            error_code="UNSUPPORTED_FORMAT",
            details={
                "extension": extension,
                "mime_type": mime_type,
            },
            recoverable=False,
        )


class CorruptedFileError(FastParseError):
    def __init__(self, filename: str, file_type: str, original_error: Optional[str] = None):
        super().__init__(
            message=f"File appears to be corrupted or invalid: {filename}",
            error_code="CORRUPTED_FILE",
            details={
                "filename": filename,
                "file_type": file_type,
                "original_error": original_error,
            },
            recoverable=False,
        )


class EncodingError(FastParseError):
    def __init__(self, filename: str, detected_encoding: Optional[str] = None):
        super().__init__(
            message=f"Failed to decode file content: {filename}",
            error_code="ENCODING_ERROR",
            details={
                "filename": filename,
                "detected_encoding": detected_encoding,
            },
            recoverable=True,
        )


class DependencyMissingError(FastParseError):
    def __init__(self, dependency: str, file_type: str):
        super().__init__(
            message=f"Required dependency '{dependency}' not installed for {file_type} parsing",
            error_code="DEPENDENCY_MISSING",
            details={
                "dependency": dependency,
                "file_type": file_type,
            },
            recoverable=False,
        )


class SecurityWarningError(FastParseError):
    def __init__(self, filename: str, patterns_found: list):
        super().__init__(
            message=f"Potentially dangerous content detected in: {filename}",
            error_code="SECURITY_WARNING",
            details={
                "filename": filename,
                "patterns_found": patterns_found,
            },
            recoverable=True,
        )


class TimeoutError(FastParseError):
    def __init__(self, operation: str, timeout_seconds: float):
        super().__init__(
            message=f"Operation '{operation}' timed out after {timeout_seconds}s",
            error_code="TIMEOUT",
            details={
                "operation": operation,
                "timeout_seconds": timeout_seconds,
            },
            recoverable=True,
        )


class ImageAnalysisError(FastParseError):
    def __init__(self, filename: str, reason: str):
        super().__init__(
            message=f"Image analysis failed for {filename}: {reason}",
            error_code="IMAGE_ANALYSIS_ERROR",
            details={
                "filename": filename,
                "reason": reason,
            },
            recoverable=True,
        )


class FileNotFoundError(FastParseError):
    def __init__(self, file_path: str):
        super().__init__(
            message=f"File not found: {file_path}",
            error_code="FILE_NOT_FOUND",
            details={
                "file_path": file_path,
            },
            recoverable=False,
        )


class TruncationWarning(FastParseError):
    def __init__(self, filename: str, original_size: int, truncated_size: int, unit: str = "chars"):
        super().__init__(
            message=f"Content truncated from {original_size:,} to {truncated_size:,} {unit}",
            error_code="CONTENT_TRUNCATED",
            details={
                "filename": filename,
                "original_size": original_size,
                "truncated_size": truncated_size,
                "unit": unit,
            },
            recoverable=True,
        )


def classify_exception(e: Exception, filename: str = "") -> FastParseError:
    if isinstance(e, FastParseError):
        return e
    
    error_msg = str(e).lower()
    
    if "corrupted" in error_msg or "invalid" in error_msg or "malformed" in error_msg:
        return CorruptedFileError(filename, "unknown", str(e))
    
    if "decode" in error_msg or "encoding" in error_msg or "unicode" in error_msg:
        return EncodingError(filename)
    
    if "not found" in error_msg or "does not exist" in error_msg:
        return FileNotFoundError(filename)
    
    if "timeout" in error_msg or "timed out" in error_msg:
        return TimeoutError("parse", 0)
    
    if "import" in error_msg or "module" in error_msg:
        return DependencyMissingError("unknown", "unknown")
    
    return FastParseError(
        message=str(e),
        error_code="UNKNOWN_ERROR",
        details={"original_type": type(e).__name__, "filename": filename},
    )

