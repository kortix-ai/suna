"""
System Prompt Module

This module provides system prompts for Suna.so AI agents.
It now uses a modular YAML + JSON approach for efficient prompt generation.

The original monolithic prompt has been replaced with a modular system that:
- Reduces token usage by 92% (25,000+ → 2,000 tokens)
- Allows conditional loading based on context
- Provides better maintainability and extensibility
- Uses YAML for configuration and JSON schemas for tool definitions

Usage:
    # Get optimized prompt for specific context
    from backend.core.prompts.prompt import get_system_prompt
    prompt = get_system_prompt(context="file")  # Only file operations

    # Get full prompt with all capabilities
    prompt = get_system_prompt(context="full")

    # Use the default prompt string (for backward compatibility)
    from backend.core.prompts.prompt import SYSTEM_PROMPT
"""

import datetime
from typing import Optional
from pathlib import Path

# Import the modular prompt assembler
try:
    from .prompt_system.assembler import (
        PromptAssembler,
        get_assembler,
        get_system_prompt as _get_system_prompt
    )
    MODULAR_SYSTEM_AVAILABLE = True
except ImportError as e:
    MODULAR_SYSTEM_AVAILABLE = False
    raise ImportError(
        f"Failed to import modular prompt system: {e}. "
        "Ensure prompt_system module is properly installed."
    )


def get_system_prompt(
    context: str = "full"
) -> str:
    """
    Get system prompt for the AI agent.

    Args:
        context: Context for prompt generation. Options:
            - 'file': File operations and knowledge base only (~1,200 tokens)
            - 'web': Web development and file operations (~900 tokens)
            - 'browser': Browser automation and web tools (~900 tokens)
            - 'design': Design tools and image generation (~850 tokens)
            - 'agent': Agent management and coordination (~900 tokens)
            - 'full': All capabilities (~2,200 tokens)

    Returns:
        Assembled system prompt string

    Examples:
        >>> # Get optimized prompt for file operations only
        >>> prompt = get_system_prompt(context="file")
        >>>
        >>> # Get full prompt with all capabilities
        >>> prompt = get_system_prompt(context="full")
    """
    if not MODULAR_SYSTEM_AVAILABLE:
        raise ImportError(
            "Modular prompt system not available. "
            "Ensure prompt_system module is properly installed."
        )

    return _get_system_prompt(context=context)


def get_custom_prompt(
    include_tools: Optional[list] = None,
    include_templates: Optional[list] = None
) -> str:
    """
    Get a custom system prompt with specific tools and templates.

    Args:
        include_tools: List of tool schemas to include.
            Available: ['files', 'knowledge_base', 'web', 'agents', 'design']
        include_templates: List of templates to include.
            Available: ['files', 'web', 'browser', 'design', 'agents']

    Returns:
        Custom assembled system prompt string

    Examples:
        >>> # Only file operations and web tools
        >>> prompt = get_custom_prompt(
        ...     include_tools=['files', 'web'],
        ...     include_templates=['files', 'web']
        ... )
    """
    if not MODULAR_SYSTEM_AVAILABLE:
        raise ImportError(
            "Modular prompt system not available. "
            "Ensure prompt_system module is properly installed."
        )

    assembler = get_assembler()
    return assembler.assemble_prompt(
        include_tools=include_tools,
        include_templates=include_templates
    )


def get_full_prompt() -> str:
    """
    Get the complete system prompt with all capabilities.
    This is equivalent to get_system_prompt(context="full").

    Returns:
        Complete system prompt with all tools and templates (~2,200 tokens)
    """
    if not MODULAR_SYSTEM_AVAILABLE:
        raise ImportError(
            "Modular prompt system not available. "
            "Ensure prompt_system module is properly installed."
        )

    assembler = get_assembler()
    return assembler.get_full_prompt()


# Default system prompt - uses modular system
if not MODULAR_SYSTEM_AVAILABLE:
    raise ImportError(
        "Modular prompt system not available. "
        "Ensure prompt_system module is properly installed."
    )

SYSTEM_PROMPT = get_system_prompt(context="full")

# Export all public functions and constants
__all__ = [
    'get_system_prompt',
    'get_custom_prompt',
    'get_full_prompt',
    'SYSTEM_PROMPT',
]
