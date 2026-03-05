from dataclasses import dataclass, field
from typing import Set, Optional

@dataclass
class FastParseConfig:
    max_file_size_bytes: int = 100 * 1024 * 1024
    max_pdf_pages: int = 500
    max_excel_rows: int = 100_000
    max_excel_sheets: int = 50
    max_text_chars: int = 10_000_000
    chunk_size: int = 65536
    enable_script_detection: bool = True
    enable_image_analysis: bool = True
    image_analysis_timeout: float = 30.0
    
    dangerous_patterns: Set[str] = field(default_factory=lambda: {
        "<script",
        "javascript:",
        "vbscript:",
        "data:text/html",
        "eval(",
        "exec(",
        "__import__",
        "os.system",
        "subprocess",
        "shell=True",
    })
    
    text_extensions: Set[str] = field(default_factory=lambda: {
        ".txt", ".md", ".markdown", ".rst", ".log", ".csv", ".tsv",
        ".json", ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
        ".html", ".htm", ".css", ".scss", ".sass", ".less",
        ".py", ".pyw", ".pyi", ".pyx",
        ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
        ".java", ".kt", ".kts", ".scala", ".groovy",
        ".c", ".h", ".cpp", ".hpp", ".cc", ".cxx", ".hxx",
        ".cs", ".fs", ".fsx",
        ".go", ".rs", ".swift", ".m", ".mm",
        ".rb", ".rake", ".gemspec",
        ".php", ".phtml",
        ".pl", ".pm", ".pod",
        ".lua", ".r", ".R", ".jl",
        ".sh", ".bash", ".zsh", ".fish", ".ps1", ".psm1", ".bat", ".cmd",
        ".sql", ".graphql", ".gql",
        ".vue", ".svelte", ".astro",
        ".dockerfile", ".docker",
        ".makefile", ".cmake",
        ".env", ".envrc", ".gitignore", ".gitattributes",
        ".editorconfig", ".prettierrc", ".eslintrc",
    })
    
    binary_extensions: Set[str] = field(default_factory=lambda: {
        ".exe", ".dll", ".so", ".dylib", ".bin",
        ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
        ".iso", ".dmg",
    })
    
    image_extensions: Set[str] = field(default_factory=lambda: {
        ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp",
        ".tiff", ".tif", ".ico", ".svg", ".heic", ".heif",
        ".raw", ".cr2", ".nef", ".arw", ".dng",
    })
    
    pdf_extensions: Set[str] = field(default_factory=lambda: {".pdf"})
    
    word_extensions: Set[str] = field(default_factory=lambda: {
        ".docx", ".doc", ".odt", ".rtf",
    })
    
    excel_extensions: Set[str] = field(default_factory=lambda: {
        ".xlsx", ".xls", ".xlsm", ".xlsb", ".ods", ".csv",
    })
    
    presentation_extensions: Set[str] = field(default_factory=lambda: {
        ".pptx", ".ppt", ".odp",
    })

DEFAULT_CONFIG = FastParseConfig()
