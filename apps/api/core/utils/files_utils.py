
import os
import unicodedata
from urllib.parse import unquote

# Unicode space characters that should be normalized to ASCII space
UNICODE_SPACES = [
    '\u00A0',  # Non-breaking space
    '\u2000',  # En quad
    '\u2001',  # Em quad
    '\u2002',  # En space
    '\u2003',  # Em space
    '\u2004',  # Three-per-em space
    '\u2005',  # Four-per-em space
    '\u2006',  # Six-per-em space
    '\u2007',  # Figure space
    '\u2008',  # Punctuation space
    '\u2009',  # Thin space
    '\u200A',  # Hair space
    '\u202F',  # Narrow no-break space (common in macOS screenshots)
    '\u205F',  # Medium mathematical space
    '\u3000',  # Ideographic space
]

# Characters that cause issues in Unix filesystems and shell commands
# These are replaced with safe alternatives
UNSAFE_CHAR_REPLACEMENTS = {
    ':': '-',   # Colons not allowed in many filesystems
    '*': '-',   # Wildcard character
    '?': '-',   # Wildcard character
    '"': "'",   # Double quotes can break shell commands
    '<': '-',   # Redirect operator
    '>': '-',   # Redirect operator
    '|': '-',   # Pipe operator
    '\0': '',   # Null character
    '\n': '_',  # Newline
    '\r': '_',  # Carriage return
    '\t': '_',  # Tab
}

# Files to exclude from operations
EXCLUDED_FILES = {
    ".DS_Store",
    ".gitignore",
    "package-lock.json",
    "postcss.config.js",
    "postcss.config.mjs",
    "jsconfig.json",
    "components.json",
    "tsconfig.tsbuildinfo",
    "tsconfig.json",
}

# Directories to exclude from operations
EXCLUDED_DIRS = {
    "node_modules",
    ".next",
    "dist",
    "build",
    ".git"
}

# File extensions to exclude from operations
EXCLUDED_EXT = {
    ".ico",
    ".svg",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".bmp",
    ".tiff",
    ".webp",
    ".db",
    ".sql"
}

def should_exclude_file(rel_path: str) -> bool:
    """Check if a file should be excluded based on path, name, or extension
    
    Args:
        rel_path: Relative path of the file to check
        
    Returns:
        True if the file should be excluded, False otherwise
    """
    # Check filename
    filename = os.path.basename(rel_path)
    if filename in EXCLUDED_FILES:
        return True

    # Check directory
    dir_path = os.path.dirname(rel_path)
    if any(excluded in dir_path for excluded in EXCLUDED_DIRS):
        return True

    # Check extension
    _, ext = os.path.splitext(filename)
    if ext.lower() in EXCLUDED_EXT:
        return True

    return False 

def normalize_filename(filename: str) -> str:
    """Normalize a single filename (not a path) for Unix compatibility.

    Handles:
    - URL decoding (handles %20, %E2%80%AF, etc.)
    - Unicode normalization to NFC form
    - Unicode space characters → ASCII space
    - Unsafe shell/filesystem characters → safe alternatives
    - Trimming of leading/trailing spaces and dots

    This is critical for files uploaded from macOS which may use
    narrow no-break spaces (\\u202F) in screenshot filenames, and
    for any file with special characters that could break shell commands.

    Args:
        filename: The filename to normalize (should not contain path separators)

    Returns:
        Normalized filename safe for Unix filesystems and shell commands
    """
    if not filename:
        return filename

    try:
        # URL-decode if needed (handles %20, %E2%80%AF, etc.)
        try:
            filename = unquote(filename)
        except Exception:
            pass

        # Normalize to NFC (Normalized Form Composed)
        filename = unicodedata.normalize('NFC', filename)

        # Replace Unicode spaces with ASCII space
        for unicode_space in UNICODE_SPACES:
            filename = filename.replace(unicode_space, ' ')

        # Replace unsafe characters with safe alternatives
        for unsafe_char, safe_char in UNSAFE_CHAR_REPLACEMENTS.items():
            filename = filename.replace(unsafe_char, safe_char)

        # Trim leading/trailing spaces and dots (can cause issues)
        # But preserve the extension's dot
        name, ext = os.path.splitext(filename)
        name = name.strip().strip('.')

        # If name is empty after stripping, use a default
        if not name:
            name = 'file'

        filename = name + ext

        return filename
    except Exception:
        # Fallback: keep only safe ASCII characters
        import re
        return re.sub(r'[^a-zA-Z0-9._\- ]', '_', filename)


def normalize_path(path: str) -> str:
    """Normalize a file path for Unix compatibility.

    Normalizes each component of the path (directories and filename) while
    preserving the path structure. Handles Unicode characters, special
    characters, and macOS-specific encoding issues.

    Args:
        path: The file path to normalize

    Returns:
        Normalized path safe for Unix filesystems and shell commands
    """
    if not path:
        return path

    try:
        # URL-decode the entire path first
        try:
            path = unquote(path)
        except Exception:
            pass

        # Normalize Unicode to NFC form
        path = unicodedata.normalize('NFC', path)

        # Replace Unicode spaces with ASCII space throughout the path
        for unicode_space in UNICODE_SPACES:
            path = path.replace(unicode_space, ' ')

        # Split path into components and normalize each part
        # Preserve leading slash if present
        leading_slash = path.startswith('/')
        parts = path.split('/')

        normalized_parts = []
        for i, part in enumerate(parts):
            if not part:  # Empty part (from leading/trailing/double slashes)
                if i == 0 and leading_slash:
                    continue  # Skip empty part from leading slash
                continue

            # Replace unsafe characters in each path component
            for unsafe_char, safe_char in UNSAFE_CHAR_REPLACEMENTS.items():
                part = part.replace(unsafe_char, safe_char)

            # Trim spaces from each component (but keep internal spaces)
            part = part.strip()

            if part:  # Only add non-empty parts
                normalized_parts.append(part)

        # Reconstruct the path
        result = '/'.join(normalized_parts)
        if leading_slash:
            result = '/' + result

        return result
    except Exception:
        return path


def clean_path(path: str, workspace_path: str = "/workspace") -> str:
    """Clean and normalize a path to be relative to the workspace.

    ALWAYS returns a relative path without the /workspace prefix.
    Tools should prepend workspace_path to get the full absolute path.

    Also normalizes Unicode characters and special characters to handle macOS
    screenshot filenames with narrow no-break spaces and other problematic chars.

    Args:
        path: The path to clean
        workspace_path: The base workspace path to remove (default: "/workspace")

    Returns:
        A cleaned relative path (never starts with /workspace or /)

    Examples:
        "/workspace/uploads/image.png" -> "uploads/image.png"
        "workspace/uploads/image.png" -> "uploads/image.png"
        "uploads/image.png" -> "uploads/image.png"
        "/uploads/image.png" -> "uploads/image.png"
    """
    # Normalize Unicode and special characters in the path
    path = normalize_path(path)

    # Strip the absolute /workspace prefix if present
    if path.startswith('/workspace/'):
        path = path[len('/workspace/'):]
    elif path.startswith('/workspace'):
        path = path[len('/workspace'):]

    # Remove any leading slash
    path = path.lstrip('/')

    # Remove workspace prefix if present (for paths like "workspace/foo")
    if path.startswith(workspace_path.lstrip('/')):
        path = path[len(workspace_path.lstrip('/')):]

    # Remove workspace/ prefix if present (handles "workspace/uploads/...")
    if path.startswith('workspace/'):
        path = path[len('workspace/'):]

    # Remove any remaining leading slash
    path = path.lstrip('/')

    return path 