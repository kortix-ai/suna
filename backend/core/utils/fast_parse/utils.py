from __future__ import annotations
import re
import unicodedata
from typing import Optional, Tuple, Dict, Any, List
from pathlib import Path

from .parser import ParseResult, FileType


def sanitize_filename(filename: str, max_length: int = 255) -> str:
    name, ext = Path(filename).stem, Path(filename).suffix
    
    name = unicodedata.normalize("NFKD", name)
    name = name.encode("ascii", "ignore").decode("ascii")
    
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name)
    
    name = re.sub(r"\s+", "_", name)
    
    name = re.sub(r"_+", "_", name)
    
    name = name.strip("_. ")
    
    if not name:
        name = "file"
    
    max_name_len = max_length - len(ext) - 1
    if len(name) > max_name_len:
        name = name[:max_name_len]
    
    return f"{name}{ext}"


def sanitize_filename_for_path(filename: str) -> str:
    safe = filename.replace('/', '_').replace('\\', '_')
    safe = re.sub(r'[\[\]{}()<>|`#%&*?!@$^+=;:\'",]', '_', safe)
    safe = re.sub(r'\s+', '_', safe)
    safe = re.sub(r'_+', '_', safe)
    safe = safe.strip('_')
    return safe or 'file'


def format_file_size(size_bytes: int) -> str:
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    elif size_bytes < 1024 * 1024 * 1024:
        return f"{size_bytes / (1024 * 1024):.1f} MB"
    else:
        return f"{size_bytes / (1024 * 1024 * 1024):.2f} GB"


def get_file_extension(filename: str) -> str:
    return Path(filename).suffix.lower()


def get_mime_type(filename: str) -> str:
    import mimetypes
    mime_type, _ = mimetypes.guess_type(filename)
    return mime_type or "application/octet-stream"


def normalize_mime_type(mime_type: str) -> str:
    """
    Normalize MIME types to match the allowed_mime_types in the staged-files bucket.
    Maps unsupported MIME types to their supported equivalents.
    """
    # Map of unsupported MIME types to supported ones
    mime_type_mapping = {
        # Python variants
        'text/x-python-script': 'text/x-python',
        'application/x-python': 'text/x-python',
        'text/python': 'text/x-python',
        
        # Other common variants that might not be in the allowed list
        'text/x-csrc': 'text/x-c',
        'text/x-chdr': 'text/x-c',
        'text/x-c++src': 'text/x-c++',
        'text/x-c++hdr': 'text/x-c++',
        'text/x-cpp': 'text/x-c++',
        'text/x-h': 'text/x-c',
        
        # Shell script variants
        'text/x-bash': 'text/x-shellscript',
        'text/x-sh': 'text/x-shellscript',
        'application/x-sh': 'text/x-shellscript',
        
        # YAML variants
        'text/yaml': 'text/x-yaml',
        'application/yaml': 'application/x-yaml',
        
        # JSON variants
        'text/json': 'application/json',
        
        # XML variants
        'text/x-xml': 'text/xml',
    }
    
    # Check if we have a direct mapping
    if mime_type in mime_type_mapping:
        return mime_type_mapping[mime_type]
    
    # Return original if no mapping needed
    return mime_type


def strip_script_tags(content: str) -> str:
    content = re.sub(r"<script[^>]*>.*?</script>", "", content, flags=re.DOTALL | re.IGNORECASE)
    content = re.sub(r"javascript:", "", content, flags=re.IGNORECASE)
    content = re.sub(r"vbscript:", "", content, flags=re.IGNORECASE)
    content = re.sub(r"on\w+\s*=\s*[\"'][^\"']*[\"']", "", content, flags=re.IGNORECASE)
    return content


def normalize_whitespace(content: str) -> str:
    content = re.sub(r"[ \t]+", " ", content)
    content = re.sub(r"\n{3,}", "\n\n", content)
    return content.strip()


def truncate_content(
    content: str,
    max_chars: int,
    ellipsis: str = "...",
    preserve_words: bool = True,
) -> Tuple[str, bool]:
    if len(content) <= max_chars:
        return content, False
    
    if not preserve_words:
        return content[:max_chars - len(ellipsis)] + ellipsis, True
    
    truncated = content[:max_chars - len(ellipsis)]
    last_space = truncated.rfind(" ")
    
    if last_space > max_chars * 0.7:
        truncated = truncated[:last_space]
    
    return truncated + ellipsis, True


def extract_preview(
    content: str,
    max_lines: int = 10,
    max_chars_per_line: int = 200,
) -> str:
    lines = content.splitlines()[:max_lines]
    
    preview_lines = []
    for line in lines:
        if len(line) > max_chars_per_line:
            line = line[:max_chars_per_line] + "..."
        preview_lines.append(line)
    
    preview = "\n".join(preview_lines)
    
    if len(content.splitlines()) > max_lines:
        preview += f"\n... ({len(content.splitlines()) - max_lines} more lines)"
    
    return preview


def format_parse_result(
    result: ParseResult,
    include_content: bool = True,
    content_preview_length: int = 500,
) -> str:
    parts = []
    
    parts.append(f"File: {result.filename}")
    parts.append(f"Type: {result.file_type.name}")
    parts.append(f"Size: {format_file_size(result.file_size)}")
    parts.append(f"MIME: {result.mime_type}")
    parts.append(f"Status: {'Success' if result.success else 'Failed'}")
    
    if result.error:
        parts.append(f"Error: {result.error}")
    
    if result.warnings:
        parts.append(f"Warnings: {'; '.join(result.warnings)}")
    
    if result.metadata:
        parts.append("Metadata:")
        for key, value in result.metadata.items():
            if not isinstance(value, (dict, list)):
                parts.append(f"  {key}: {value}")
    
    if include_content and result.content:
        parts.append("")
        parts.append("Content Preview:")
        parts.append("-" * 40)
        if len(result.content) > content_preview_length:
            parts.append(result.content[:content_preview_length] + "...")
        else:
            parts.append(result.content)
    
    return "\n".join(parts)


def result_to_markdown(result: ParseResult) -> str:
    parts = []
    
    parts.append(f"# {result.filename}")
    parts.append("")
    parts.append("## File Information")
    parts.append(f"- **Type:** {result.file_type.name}")
    parts.append(f"- **Size:** {format_file_size(result.file_size)}")
    parts.append(f"- **MIME Type:** {result.mime_type}")
    
    if result.metadata:
        parts.append("")
        parts.append("## Metadata")
        for key, value in result.metadata.items():
            if isinstance(value, dict):
                parts.append(f"### {key}")
                for k, v in value.items():
                    parts.append(f"- **{k}:** {v}")
            elif isinstance(value, list):
                parts.append(f"- **{key}:** {', '.join(str(v) for v in value)}")
            else:
                parts.append(f"- **{key}:** {value}")
    
    if result.warnings:
        parts.append("")
        parts.append("## Warnings")
        for warning in result.warnings:
            parts.append(f"- ⚠️ {warning}")
    
    if result.error:
        parts.append("")
        parts.append("## Error")
        parts.append(f"❌ {result.error}")
    
    if result.content:
        parts.append("")
        parts.append("## Content")
        parts.append("```")
        parts.append(result.content)
        parts.append("```")
    
    return "\n".join(parts)


def is_supported_file(filename: str, config=None) -> bool:
    from .config import DEFAULT_CONFIG
    cfg = config or DEFAULT_CONFIG
    
    ext = get_file_extension(filename)
    
    all_extensions = set()
    all_extensions.update(cfg.text_extensions)
    all_extensions.update(cfg.pdf_extensions)
    all_extensions.update(cfg.word_extensions)
    all_extensions.update(cfg.excel_extensions)
    all_extensions.update(cfg.presentation_extensions)
    all_extensions.update(cfg.image_extensions)
    
    return ext in all_extensions


def get_supported_extensions() -> Dict[str, List[str]]:
    from .config import DEFAULT_CONFIG
    
    return {
        "text": sorted(DEFAULT_CONFIG.text_extensions),
        "pdf": sorted(DEFAULT_CONFIG.pdf_extensions),
        "word": sorted(DEFAULT_CONFIG.word_extensions),
        "excel": sorted(DEFAULT_CONFIG.excel_extensions),
        "presentation": sorted(DEFAULT_CONFIG.presentation_extensions),
        "image": sorted(DEFAULT_CONFIG.image_extensions),
    }


def merge_parse_results(results: List[ParseResult], separator: str = "\n\n---\n\n") -> ParseResult:
    if not results:
        return ParseResult(
            success=False,
            content="",
            file_type=FileType.UNKNOWN,
            filename="merged",
            mime_type="text/plain",
            file_size=0,
            error="No results to merge",
        )
    
    if len(results) == 1:
        return results[0]
    
    contents = []
    total_size = 0
    all_warnings = []
    all_metadata = {}
    any_failed = False
    
    for i, result in enumerate(results):
        if result.success and result.content:
            contents.append(f"=== {result.filename} ===\n{result.content}")
        elif result.error:
            contents.append(f"=== {result.filename} ===\n[Error: {result.error}]")
            any_failed = True
        
        total_size += result.file_size
        all_warnings.extend(result.warnings)
        all_metadata[result.filename] = result.metadata
    
    return ParseResult(
        success=not any_failed,
        content=separator.join(contents),
        file_type=FileType.TEXT,
        filename="merged_files",
        mime_type="text/plain",
        file_size=total_size,
        metadata={"files": all_metadata, "file_count": len(results)},
        warnings=all_warnings,
    )

