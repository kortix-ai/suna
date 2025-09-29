"""
Modular System Prompt Assembler

Dynamically assembles prompts from YAML/JSON components for maximum efficiency.
This module provides the core functionality for building structured system prompts
from modular configuration files, tool schemas, and context templates.
"""

import json
import os
from pathlib import Path
from typing import Dict, List, Optional, Any
import yaml
from functools import lru_cache


class PromptAssembler:
    """
    Dynamic prompt assembler that builds system prompts from modular YAML/JSON components.
    Implements caching, validation, and conditional loading for token efficiency.

    Attributes:
        base_path: Root directory of the prompt system
        config_path: Path to configuration files (YAML)
        schemas_path: Path to tool schema definitions (JSON)
        templates_path: Path to context templates (YAML)
    """

    def __init__(self, base_path: Optional[str] = None):
        """Initialize the prompt assembler with base path to prompt_system directory."""
        if base_path is None:
            base_path = Path(__file__).parent
        self.base_path = Path(base_path)
        self.config_path = self.base_path / "config"
        self.schemas_path = self.base_path / "schemas"
        self.templates_path = self.base_path / "templates"

        # Cache for loaded components
        self._cache = {}
        self._assembly_cache = {}  # Cache for assembled prompts

    def _load_yaml(self, file_path: Path) -> Dict[str, Any]:
        """Load and parse YAML file with caching."""
        cache_key = str(file_path)
        if cache_key in self._cache:
            return self._cache[cache_key]

        with open(file_path, 'r', encoding='utf-8') as f:
            data = yaml.safe_load(f)

        self._cache[cache_key] = data
        return data

    def _load_json(self, file_path: Path) -> Dict[str, Any]:
        """Load and parse JSON file with caching."""
        cache_key = str(file_path)
        if cache_key in self._cache:
            return self._cache[cache_key]

        with open(file_path, 'r', encoding='utf-8') as f:
            data = json.load(f)

        self._cache[cache_key] = data
        return data

    def load_config(self) -> Dict[str, Any]:
        """Load main system configuration."""
        main_config = self._load_yaml(self.config_path / "system.yaml")

        # Load included configs
        config = {}
        config.update(main_config)

        if "includes" in main_config:
            for include_file in main_config["includes"]:
                include_path = self.config_path / include_file
                included_data = self._load_yaml(include_path)
                config.update(included_data)

        return config

    def load_tool_schema(self, schema_name: str) -> Dict[str, Any]:
        """
        Load a specific tool schema by name.

        Args:
            schema_name: Name of the schema file (without .json extension)
                        e.g., 'files', 'web', 'design', 'agents', 'knowledge_base'

        Returns:
            Dictionary containing the JSON schema definition
        """
        schema_file = self.schemas_path / f"{schema_name}.json"
        return self._load_json(schema_file)

    def load_template(self, template_name: str) -> Dict[str, Any]:
        """Load a specific template by name."""
        template_file = self.templates_path / f"{template_name}.yaml"
        return self._load_yaml(template_file)

    def _format_agent_identity(self, config: Dict[str, Any]) -> str:
        """Format agent identity section."""
        agent = config.get("agent", {})
        behavior = config.get("behavior", {})
        principles = config.get("principles", [])

        sections = []

        # Agent identity
        sections.append(f"# Agent Identity")
        sections.append(f"{agent.get('identity_statement', '')}\n")

        # Core principles
        if principles:
            sections.append("# Core Principles")
            for principle in principles:
                if principle.get("priority") == "critical":
                    sections.append(f"**{principle['name']}** (CRITICAL):")
                    sections.append(f"  {principle['rule']}\n")

        return "\n".join(sections)

    def _format_environment(self, config: Dict[str, Any]) -> str:
        """Format environment and capabilities section."""
        env = config.get("environment", {})
        caps = config.get("capabilities", {})

        sections = []
        sections.append("# Execution Environment")

        # Base environment
        if "base" in env:
            base = env["base"]
            sections.append(f"- OS: {base.get('os', 'N/A')}")
            sections.append(f"- Python: {base.get('python_version', 'N/A')}")

        # Capabilities summary
        sections.append("\n# Operational Capabilities")
        for cap_name, cap_value in caps.items():
            if isinstance(cap_value, list):
                formatted = ', '.join(str(item) for item in cap_value)
            elif isinstance(cap_value, dict):
                # Format dict as key: value pairs
                formatted = ', '.join(f"{k}: {v}" for k, v in cap_value.items())
            else:
                formatted = str(cap_value)
            sections.append(f"**{cap_name.replace('_', ' ').title()}**: {formatted}")

        return "\n".join(sections)

    def _format_tool_schema(self, schema: Dict[str, Any]) -> str:
        """Format tool schema into concise documentation."""
        tools = schema.get("tools", [])

        sections = []
        sections.append(f"## {schema.get('title', 'Tools')}")

        for tool in tools:
            name = tool["name"]
            desc = tool["description"]
            sections.append(f"\n### {name}")
            sections.append(f"{desc}")

            # Parameters
            params = tool.get("parameters", {})
            if "properties" in params:
                sections.append("\n**Parameters:**")
                required = params.get("required", [])
                for param_name, param_info in params["properties"].items():
                    req = " (required)" if param_name in required else ""
                    param_desc = param_info.get("description", "")
                    sections.append(f"- `{param_name}`: {param_info.get('type', 'any')}{req} - {param_desc}")

            # Critical notes
            if "critical_notes" in tool:
                sections.append("\n**Critical Notes:**")
                for note in tool["critical_notes"]:
                    sections.append(f"- {note}")

        return "\n".join(sections)

    def _format_template(self, template: Dict[str, Any]) -> str:
        """Format template into prompt instructions."""
        sections = []

        # Critical rules
        if "critical_rules" in template:
            sections.append("## Critical Rules")
            for rule in template["critical_rules"]:
                sections.append(f"- **{rule['rule']}**")
                if "reason" in rule:
                    sections.append(f"  Reason: {rule['reason']}")

        # Example workflows
        if "example_workflows" in template:
            sections.append("\n## Workflows")
            for workflow_name, steps in template["example_workflows"].items():
                sections.append(f"\n**{workflow_name.replace('_', ' ').title()}:**")
                for i, step in enumerate(steps, 1):
                    sections.append(f"{i}. {step}")

        return "\n".join(sections)

    def assemble_prompt(
        self,
        context: Optional[str] = None,
        include_tools: Optional[List[str]] = None,
        include_templates: Optional[List[str]] = None
    ) -> str:
        """
        Assemble complete system prompt based on context and requirements.

        Args:
            context: Optional context identifier for conditional loading
            include_tools: List of tool schemas to include (e.g., ['file_operations', 'web_operations'])
            include_templates: List of templates to include (e.g., ['file_ops', 'browser'])

        Returns:
            Assembled system prompt string
        """
        # Create cache key
        cache_key = (
            context,
            tuple(include_tools) if include_tools else None,
            tuple(include_templates) if include_templates else None
        )

        # Check cache
        if cache_key in self._assembly_cache:
            return self._assembly_cache[cache_key]

        sections = []

        # Load configuration
        config = self.load_config()

        # Format core sections
        sections.append(self._format_agent_identity(config))
        sections.append(self._format_environment(config))

        # Load and format tool schemas
        if include_tools:
            sections.append("\n# Available Tools")
            for tool_name in include_tools:
                try:
                    schema = self.load_tool_schema(tool_name)
                    sections.append(self._format_tool_schema(schema))
                except FileNotFoundError:
                    print(f"Warning: Tool schema '{tool_name}' not found")

        # Load and format templates
        if include_templates:
            sections.append("\n# Specialized Instructions")
            for template_name in include_templates:
                try:
                    template = self.load_template(template_name)
                    sections.append(self._format_template(template))
                except FileNotFoundError:
                    print(f"Warning: Template '{template_name}' not found")

        # Assemble and cache
        result = "\n\n".join(sections)
        self._assembly_cache[cache_key] = result
        return result

    def get_full_prompt(self) -> str:
        """
        Get the full system prompt with all capabilities.
        Use this for maximum compatibility with the original prompt.
        """
        all_tools = [
            "file_operations",
            "knowledge_base",
            "web_operations",
            "agent_management",
            "design_tools"
        ]

        all_templates = [
            "file_ops",
            "web_dev",
            "browser",
            "design",
            "agents"
        ]

        return self.assemble_prompt(
            include_tools=all_tools,
            include_templates=all_templates
        )

    def get_optimized_prompt(self, context: str) -> str:
        """
        Get an optimized prompt for specific context.
        Only loads necessary components.

        Args:
            context: One of 'file', 'web', 'browser', 'design', 'agent', 'full'
        """
        context_mappings = {
            "file": {
                "tools": ["files", "knowledge_base"],
                "templates": ["files"]
            },
            "web": {
                "tools": ["web", "files"],
                "templates": ["web"]
            },
            "browser": {
                "tools": ["web", "files"],
                "templates": ["browser"]
            },
            "design": {
                "tools": ["design", "files"],
                "templates": ["design"]
            },
            "agent": {
                "tools": ["agents"],
                "templates": ["agents"]
            },
            "full": {
                "tools": ["files", "knowledge_base", "web", "agents", "design"],
                "templates": ["files", "web", "browser", "design", "agents"]
            }
        }

        mapping = context_mappings.get(context, context_mappings["full"])

        return self.assemble_prompt(
            context=context,
            include_tools=mapping["tools"],
            include_templates=mapping["templates"]
        )

    def clear_cache(self):
        """Clear the internal cache."""
        self._cache.clear()
        self._assembly_cache.clear()


# Global assembler instance
_assembler = None

def get_assembler() -> PromptAssembler:
    """Get or create the global prompt assembler instance."""
    global _assembler
    if _assembler is None:
        _assembler = PromptAssembler()
    return _assembler


def get_system_prompt(context: str = "full") -> str:
    """
    Convenience function to get system prompt.

    Args:
        context: Context for prompt generation ('file', 'web', 'browser', 'design', 'agent', 'full')

    Returns:
        Assembled system prompt string
    """
    assembler = get_assembler()
    return assembler.get_optimized_prompt(context)