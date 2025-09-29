"""
System Prompt Module

This module provides system prompts for Suna.so AI agents using a modular
YAML + JSON approach for efficient prompt generation.

The modular system:
- Reduces token usage by 44.6% (3,896 → 2,158 tokens)
- Allows custom loading of specific tools/templates
- Provides better maintainability and extensibility

Usage:
    from backend.core.prompts.prompt import get_system_prompt

    # Get complete system prompt
    prompt = get_system_prompt()

    # Get custom prompt with specific tools
    from backend.core.prompts.prompt import get_custom_prompt
    prompt = get_custom_prompt(
        include_tools=['files', 'web'],
        include_templates=['files', 'web']
    )
"""

from .assembler import PromptAssembler

# Create assembler instance
_assembler = PromptAssembler()


def get_system_prompt() -> str:
    """
    Get the complete system prompt for the AI agent.

    Returns:
        Assembled system prompt string with all capabilities

    Examples:
        >>> prompt = get_system_prompt()
    """
    return _assembler.get_full_prompt()


def get_custom_prompt(
    include_tools: list = None,
    include_templates: list = None
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
    return _assembler.assemble_prompt(
        include_tools=include_tools,
        include_templates=include_templates
    )


# Default system prompt constant
SYSTEM_PROMPT = get_system_prompt()


# Export public API
__all__ = [
    'get_system_prompt',
    'get_custom_prompt',
    'SYSTEM_PROMPT',
]