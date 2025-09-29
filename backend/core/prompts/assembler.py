"""
Prompt assembler for building system prompts from modular components.

Loads and combines YAML configurations, JSON tool schemas, and instruction
templates into complete system prompts with caching for performance.
"""

import json
from pathlib import Path
from typing import Dict, List, Optional, Any
import yaml


class PromptAssembler:
    """Assembles system prompts from YAML/JSON components with caching."""

    def __init__(self, base_path: Optional[str] = None):
        """Initialize assembler with base path to prompt directory."""
        if base_path is None:
            base_path = Path(__file__).parent
        self.base_path = Path(base_path)
        self.config_path = self.base_path / "config"
        self.schemas_path = self.base_path / "schemas"
        self.templates_path = self.base_path / "templates"

        self._cache = {}
        self._assembly_cache = {}

    def _load_yaml(self, file_path: Path) -> Dict[str, Any]:
        """Load and cache YAML file."""
        cache_key = str(file_path)
        if cache_key in self._cache:
            return self._cache[cache_key]

        with open(file_path, 'r', encoding='utf-8') as f:
            data = yaml.safe_load(f)

        self._cache[cache_key] = data
        return data

    def _load_json(self, file_path: Path) -> Dict[str, Any]:
        """Load and cache JSON file."""
        cache_key = str(file_path)
        if cache_key in self._cache:
            return self._cache[cache_key]

        with open(file_path, 'r', encoding='utf-8') as f:
            data = json.load(f)

        self._cache[cache_key] = data
        return data

    def load_config(self) -> Dict[str, Any]:
        """Load main system configuration with includes."""
        main_config = self._load_yaml(self.config_path / "system.yaml")

        config = {}
        config.update(main_config)

        if "includes" in main_config:
            for include_file in main_config["includes"]:
                include_path = self.config_path / include_file
                included_data = self._load_yaml(include_path)
                config.update(included_data)

        return config

    def load_tool_schema(self, schema_name: str) -> Dict[str, Any]:
        """Load tool schema by name."""
        schema_file = self.schemas_path / f"{schema_name}.json"
        return self._load_json(schema_file)

    def load_template(self, template_name: str) -> Dict[str, Any]:
        """Load template by name."""
        template_file = self.templates_path / f"{template_name}.yaml"
        return self._load_yaml(template_file)

    def _format_agent_identity(self, config: Dict[str, Any]) -> str:
        """Format agent identity section."""
        agent = config.get("agent", {})
        principles = config.get("principles", [])

        sections = []
        sections.append(f"# Agent Identity")
        sections.append(f"{agent.get('identity_statement', '')}\n")

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

        if "base" in env:
            base = env["base"]
            sections.append(f"- OS: {base.get('os', 'N/A')}")
            sections.append(f"- Python: {base.get('python_version', 'N/A')}")

        sections.append("\n# Operational Capabilities")
        for cap_name, cap_value in caps.items():
            if isinstance(cap_value, list):
                formatted = ', '.join(str(item) for item in cap_value)
            elif isinstance(cap_value, dict):
                formatted = ', '.join(f"{k}: {v}" for k, v in cap_value.items())
            else:
                formatted = str(cap_value)
            sections.append(f"**{cap_name.replace('_', ' ').title()}**: {formatted}")

        return "\n".join(sections)

    def _format_tool_schema(self, schema: Dict[str, Any]) -> str:
        """Format tool schema into documentation."""
        tools = schema.get("tools", [])

        sections = []
        sections.append(f"## {schema.get('title', 'Tools')}")

        for tool in tools:
            name = tool["name"]
            desc = tool["description"]
            sections.append(f"\n### {name}")
            sections.append(f"{desc}")

            params = tool.get("parameters", {})
            if "properties" in params:
                sections.append("\n**Parameters:**")
                required = params.get("required", [])
                for param_name, param_info in params["properties"].items():
                    req = " (required)" if param_name in required else ""
                    param_desc = param_info.get("description", "")
                    sections.append(f"- `{param_name}`: {param_info.get('type', 'any')}{req} - {param_desc}")

            if "critical_notes" in tool:
                sections.append("\n**Critical Notes:**")
                for note in tool["critical_notes"]:
                    sections.append(f"- {note}")

        return "\n".join(sections)

    def _format_template(self, template: Dict[str, Any]) -> str:
        """Format template into instructions."""
        sections = []

        if "critical_rules" in template:
            sections.append("## Critical Rules")
            for rule in template["critical_rules"]:
                sections.append(f"- **{rule['rule']}**")
                if "reason" in rule:
                    sections.append(f"  Reason: {rule['reason']}")

        if "example_workflows" in template:
            sections.append("\n## Workflows")
            for workflow_name, steps in template["example_workflows"].items():
                sections.append(f"\n**{workflow_name.replace('_', ' ').title()}:**")
                for i, step in enumerate(steps, 1):
                    sections.append(f"{i}. {step}")

        return "\n".join(sections)

    def assemble_prompt(
        self,
        include_tools: Optional[List[str]] = None,
        include_templates: Optional[List[str]] = None
    ) -> str:
        """
        Assemble system prompt from specified tools and templates.

        Args:
            include_tools: Tool schemas to include
            include_templates: Templates to include

        Returns:
            Assembled system prompt string
        """
        cache_key = (
            tuple(include_tools) if include_tools else None,
            tuple(include_templates) if include_templates else None
        )

        if cache_key in self._assembly_cache:
            return self._assembly_cache[cache_key]

        sections = []

        config = self.load_config()
        sections.append(self._format_agent_identity(config))
        sections.append(self._format_environment(config))

        if include_tools:
            sections.append("\n# Available Tools")
            for tool_name in include_tools:
                try:
                    schema = self.load_tool_schema(tool_name)
                    sections.append(self._format_tool_schema(schema))
                except FileNotFoundError:
                    print(f"Warning: Tool schema '{tool_name}' not found")

        if include_templates:
            sections.append("\n# Specialized Instructions")
            for template_name in include_templates:
                try:
                    template = self.load_template(template_name)
                    sections.append(self._format_template(template))
                except FileNotFoundError:
                    print(f"Warning: Template '{template_name}' not found")

        result = "\n\n".join(sections)
        self._assembly_cache[cache_key] = result
        return result

    def get_full_prompt(self) -> str:
        """Get complete system prompt with all tools and templates."""
        return self.assemble_prompt(
            include_tools=["files", "knowledge_base", "web", "agents", "design"],
            include_templates=["files", "web", "browser", "design", "agents"]
        )

    def clear_cache(self):
        """Clear internal caches."""
        self._cache.clear()
        self._assembly_cache.clear()