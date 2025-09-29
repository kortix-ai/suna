"""
System prompt module for Suna.so AI agents.

Provides functions to generate complete or custom system prompts using a
modular YAML + JSON architecture. Reduces token usage by 44.6% compared
to the original monolithic prompt.
"""

from .assembler import PromptAssembler

_assembler = PromptAssembler()


def get_system_prompt() -> str:
    """Get the complete system prompt with all capabilities."""
    return _assembler.get_full_prompt()


def get_custom_prompt(
    include_tools: list = None,
    include_templates: list = None
) -> str:
    """
    Get a custom system prompt with specific tools and templates.

    Args:
        include_tools: Tool schemas to include
        include_templates: Templates to include

    Returns:
        Assembled system prompt string
    """
    return _assembler.assemble_prompt(
        include_tools=include_tools,
        include_templates=include_templates
    )


SYSTEM_PROMPT = get_system_prompt()