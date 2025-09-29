"""
Modular prompt system for Suna.so AI agents.

Provides prompt generation using YAML/JSON components with 44.6% token reduction.
"""

from .assembler import PromptAssembler
from .prompt import get_system_prompt, get_custom_prompt, SYSTEM_PROMPT

__version__ = "2.0.0"
__all__ = [
    "PromptAssembler",
    "get_system_prompt",
    "get_custom_prompt",
    "SYSTEM_PROMPT",
]