# i would define guide usage for agent to know about existing skills

from core.agentpress.tool import tool_metadata
from core.sandbox.tool_base import SandboxToolsBase
from core.agentpress.thread_manager import ThreadManager

@tool_metadata(
    display_name="Skills",
    description="Reference guide for using/creating skills",
    icon="Table",
    color="bg-green-100 dark:bg-green-800/50",
    weight=75,
    visible=True,
    usage_guide="""
AVAILABLE SKILLS: Pre-installed skills are located at `/skills` in the sandbox environment
  ```yaml
  skills:
    - name: slack-gif-creator
      description: Knowledge and utilities for creating animated GIFs optimized for Slack. Provides constraints, validation tools, and animation concepts. Use when users request animated GIFs for Slack like "make me a GIF of X doing Y for Slack."
      license: Complete terms in LICENSE.txt
      location: /skills/slack-gif-creator
      usage: Import Python modules by adding `/skills/slack-gif-creator` to sys.path, then use `from core.gif_builder import GIFBuilder` or `from core.validators import validate_gif`
    
    - name: webapp-testing
      description: Toolkit for interacting with and testing local web applications using Playwright. Supports verifying frontend functionality, debugging UI behavior, capturing browser screenshots, and viewing browser logs.
      license: Complete terms in LICENSE.txt
      location: /skills/webapp-testing
      usage: Use Playwright tools and utilities located at `/skills/webapp-testing` for testing web applications, verifying UI behavior, capturing screenshots, and debugging frontend issues.
    
    - name: algorithmic-art
      description: Creating algorithmic art using p5.js with seeded randomness and interactive parameter exploration. Use this when users request creating art using code, generative art, algorithmic art, flow fields, or particle systems. Create original algorithmic art rather than copying existing artists' work to avoid copyright violations.
      license: Complete terms in LICENSE.txt
      location: /skills/algorithmic-art
      usage: Access templates, examples, and documentation at `/skills/algorithmic-art` for creating p5.js generative art with interactive viewers, seeded randomness, and parameter controls.
  ```

### 🎨 **CRITICAL: Skills Awareness and Usage**

**Progressive Disclosure Principle**: Skills use a multi-level approach:
1. **Level 1 (Always Loaded)**: Skill name and description from YAML frontmatter - you see these immediately
2. **Level 2 (Triggered)**: Full SKILL.md content - loaded when you determine the skill is relevant
3. **Level 3+ (On-Demand)**: Additional referenced files - loaded only when needed for specific tasks

**When to Use Skills**:
- **slack-gif-creator**: When users request animated GIFs for Slack, need GIF optimization, or want animation concepts
- **webapp-testing**: When users need to test web applications, verify frontend functionality, debug UI behavior, capture screenshots, or view browser logs
- **algorithmic-art**: When users request generative art, algorithmic art, flow fields, particle systems, or creating art using code (p5.js)

**How to Access Skills**:
1. **Check if skill is relevant** based on the task description
2. **Read the skill's SKILL.md file** from `/skills/[skill-name]/SKILL.md` to understand full capabilities
3. **Reference additional files** within the skill directory as needed (templates, examples, utilities)
4. **Use skill utilities** by importing from the skill's location or executing scripts within the skill directory using bash commands.

**CRITICAL**: Always consider available skills when analyzing user requests. Skills provide specialized knowledge and tools that extend your capabilities beyond standard tools. Don't forget to check if a skill is relevant before implementing solutions from scratch.

"""
)
class SandboxSkillsTools(SandboxToolsBase):
    """
    Guide-only tool for spreadsheet operations.
    Use create_file + execute_command with Python/openpyxl scripts - see usage_guide for examples.
    Creates temporary Python files instead of using inline Python code for better maintainability.
    """

    def __init__(self, project_id: str, thread_manager: ThreadManager):
        super().__init__(project_id, thread_manager)
