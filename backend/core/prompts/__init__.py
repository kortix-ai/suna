"""
Suna.so Modular Prompt System

A structured, maintainable system for building AI agent prompts using
YAML configuration and JSON schemas.
"""

from .assembler import PromptAssembler, get_system_prompt

__version__ = "2.0.0"
__all__ = ["PromptAssembler", "get_system_prompt"]