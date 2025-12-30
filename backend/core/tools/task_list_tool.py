from core.agentpress.tool import ToolResult, openapi_schema, tool_metadata
from core.sandbox.tool_base import SandboxToolsBase
from core.utils.logger import logger
from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field
from enum import Enum
import json
import uuid

class TaskStatus(str, Enum):
    PENDING = "pending"
    COMPLETED = "completed"
    CANCELLED = "cancelled"

class Section(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    title: str
    
class Task(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    content: str
    status: TaskStatus = TaskStatus.PENDING
    section_id: str  # Reference to section ID instead of section name

@tool_metadata(
    display_name="Task Management",
    description="Create and track your action plan with organized to-do lists",
    icon="CheckSquare",
    color="bg-amber-100 dark:bg-amber-800/50",
    is_core=True,
    usage_guide="""
### TASK MANAGEMENT SYSTEM - FOR LARGE, COMPLEX WORK ONLY

**WHEN TO CREATE TASK LISTS (ONLY FOR SIGNIFICANT TASKS):**
- **ONLY create for LARGE, COMPLEX tasks:**
  * Extensive multi-item research (10+ items, countries, companies, topics, products, etc.)
  * Large-scale data gathering and analysis projects
  * Complex content creation projects (presentations, reports, multi-file projects)
  * Multi-phase processes requiring significant planning
  * Projects with 5+ distinct steps that need tracking
  * Comparative analysis across many items (10+)
  * Tasks that will take substantial time and require progress tracking
- **DO NOT create task lists for:**
  * Simple questions or single-step tasks
  * Small research requests (1-3 items)
  * Quick content edits or small file changes
  * Tasks that can be completed in one response
  * Simple operations that don't require planning
  * Trivial requests answerable immediately

**CRITICAL: GRANULAR TASK BREAKDOWN - GO DEEP**

### 1. INDIVIDUAL ITEM RESEARCH TASKS
When researching multiple items, create SEPARATE tasks for EACH item:
- ❌ WRONG: "Research market strategies of 5 companies" (one task)
- ✅ CORRECT: 5 individual tasks:
  * "Research Company A: market strategy, recent initiatives, target markets, competitive positioning"
  * "Research Company B: market strategy, recent initiatives, target markets, competitive positioning"
  * ... (one comprehensive task per company/item)

**Why?** Each item needs deep, thorough research with multiple queries and sources.

### 2. RESEARCH DEPTH REQUIREMENTS
Each research task must be COMPREHENSIVE:
- Multiple search queries per item (use batch mode with multiple queries)
- Search for: current status, planned projects, funding sources, official announcements
- Cross-reference multiple authoritative sources
- Verify information from government/official sources
- Document all findings with sources
- Don't stop at first result - dig deeper

### 3. TASK CREATION STRUCTURE
Create sections in logical phases:
- **Section 1: Individual Research** - One task per item (country/company/topic)
- **Section 2: Data Verification** - Cross-check findings, verify sources
- **Section 3: Synthesis** - Compile findings into structured format
- **Section 4: Output Creation** - Create deliverables (tables, reports, presentations)

### 4. EXAMPLE: Multi-Item Research
Request: "Compare the features and pricing of 8 competing products"
✅ CORRECT TASK BREAKDOWN:
```
Section: "Individual Product Research"
- Task 1: "Research Product A: features, specifications, pricing, target market, reviews"
- Task 2: "Research Product B: features, specifications, pricing, target market, reviews"
- ... (one task per product/item, 8 total)

Section: "Data Verification & Cross-Reference"
- Task: "Verify all findings from multiple authoritative sources, cross-reference official product pages"

Section: "Compile Results"
- Task: "Create comprehensive comparison table with all findings: product, features, pricing, market, sources - deliver as CSV and Markdown formats"

Section: "Visualization"
- Task: "Create interactive dashboard page that dynamically loads from CSV/JSON data file"

Section: "Source Documentation"
- Task: "Document all sources used for verification and citation"
```

### 5. TASK CREATION RULES:
1. **GRANULARITY:** Break down into smallest meaningful units - one task per research item
2. **SPECIFICITY:** Each task should be specific, actionable, with clear completion criteria
3. **EXECUTION ORDER:** Tasks must be created in exact execution order
4. **COMPREHENSIVE:** Each research task should cover all aspects (status, plans, funding, sources)
5. **DEPTH:** Tasks should require multiple queries and sources, not single searches

**CRITICAL EXECUTION ORDER RULES:**
1. **SEQUENTIAL EXECUTION:** Execute tasks in exact order they appear
2. **ONE TASK AT A TIME:** Never execute multiple tasks simultaneously
3. **COMPLETE BEFORE MOVING:** Finish current task completely (all research done) before starting next
4. **NO SKIPPING:** Do not skip tasks or jump ahead
5. **BATCH OPERATIONS WITHIN TASKS:** Use batch mode for searches WITHIN a single task with multiple queries (e.g., country status, country plans, country funding)

**ACTIVE TASK LIST MANAGEMENT - CRUD OPERATIONS THROUGHOUT EXECUTION:**
🚨 CRITICAL: The task list is a LIVING document - actively manage it with continuous CRUD operations during execution.

**CREATE (Adding Tasks):**
- Add new tasks when you discover additional work needed during execution
- Use create_tasks to add tasks to existing sections
- Example: After researching, you discover you need to verify a specific claim → add verification task immediately

**READ (Viewing Tasks):**
- Use view_tasks regularly (after every 2-3 task completions) to:
  - Check current progress
  - Identify the next task to execute
  - Review completed work
  - Ensure you're on track
- Check progress before starting each new task

**UPDATE (Modifying Tasks):**
- **Mark complete IMMEDIATELY** after finishing each task - don't wait
- Update task content if requirements change or you refine the scope
- Batch multiple completions when efficient (e.g., completing 3 tasks at once)
- Example workflow:
  1. Finish research on Item A → use update_tasks with task_ids for item_a_task and status "completed"
  2. Check progress → use view_tasks
  3. Start Item B research
  4. Finish Item B → use update_tasks with task_ids for item_b_task and status "completed"
  5. Continue pattern...

**DELETE (Removing Tasks):**
- Remove tasks that become unnecessary or redundant
- Delete tasks if requirements change and they're no longer needed
- Use delete_tasks with task_ids when appropriate
- Example: If a task becomes redundant after discovering information, remove it immediately

**TASK MANAGEMENT RHYTHM:**
- **After completing each task:** Mark it complete immediately via update_tasks
- **Every 2-3 tasks:** Use view_tasks to check progress and identify next task
- **When discovering new work:** Add new tasks immediately via create_tasks
- **When requirements change:** Update or remove affected tasks via update_tasks or delete_tasks
- **Before final output:** Verify all tasks are complete via view_tasks

**MULTI-STEP TASK EXECUTION - NO INTERRUPTIONS:**
- Once a multi-step task starts, it MUST run all steps to completion
- NEVER ask "should I proceed?" or "do you want me to continue?" during execution
- The user approved by starting the task - no permission needed between steps
- Only pause if there's an actual blocking error
- BUT: Continue actively managing the task list (marking complete, checking progress) throughout

**TASK UPDATE EFFICIENCY:**
- ALWAYS batch task status updates in a single call when possible
- Complete current task(s) immediately after finishing
- Example: use update_tasks with task_ids for task1 and task2 and status "completed" when you've finished both

**COMPLETION SIGNAL:**
- Once ALL tasks are marked complete (verify via view_tasks), MUST call either complete or ask tool immediately
- NO additional commands after completion
- Failure to signal completion is a critical error

**RESEARCH QUALITY STANDARDS:**
- Each research task should use 3-5+ search queries (batch mode for efficiency)
- Verify findings from multiple sources (government, official announcements, reputable news)
- Document all sources for citation
- Cross-reference information to ensure accuracy
- Don't accept surface-level information - dig deeper for comprehensive understanding

**VISUALIZATION & DASHBOARDS:**
- After compiling data into CSV/JSON, automatically create interactive dashboard page
- Dashboard page must dynamically load data from CSV/JSON file (never hardcode data)
- CSV/JSON is the single source of truth - page references it, doesn't duplicate it
- Use JavaScript fetch API to load data dynamically
- Create clean, modern, responsive dashboards
- Both data file and dashboard page should be delivered together
""",
    weight=5,
    visible=True
)

class TaskListTool(SandboxToolsBase):
    """Task management system for organizing and tracking tasks. It contains the action plan for the agent to follow.
    
    Features:
    - Create, update, and delete tasks organized by sections
    - Support for batch operations across multiple sections
    - Track completion status and progress
    """
    
    def __init__(self, project_id: str, thread_manager, thread_id: str):
        super().__init__(project_id, thread_manager)
        self.thread_id = thread_id
        self.task_list_message_type = "task_list"
    
    async def _load_data(self) -> tuple[List[Section], List[Task]]:
        """Load sections and tasks from storage"""
        try:
            client = await self.thread_manager.db.client
            result = await client.table('messages').select('*')\
                .eq('thread_id', self.thread_id)\
                .eq('type', self.task_list_message_type)\
                .order('created_at', desc=True).limit(1).execute()
            
            if result.data and result.data[0].get('content'):
                content = result.data[0]['content']
                if isinstance(content, str):
                    content = json.loads(content)
                
                sections = [Section(**s) for s in content.get('sections', [])]
                tasks = [Task(**t) for t in content.get('tasks', [])]
                
                # Handle migration from old format
                if not sections and 'sections' in content:
                    # Create sections from old nested format
                    for old_section in content['sections']:
                        section = Section(title=old_section['title'])
                        sections.append(section)
                        
                        # Update tasks to reference section ID
                        for old_task in old_section.get('tasks', []):
                            task = Task(
                                content=old_task['content'],
                                status=TaskStatus(old_task.get('status', 'pending')),
                                section_id=section.id
                            )
                            if 'id' in old_task:
                                task.id = old_task['id']
                            tasks.append(task)
                
                return sections, tasks
            
            # Return empty lists - no default section
            return [], []
            
        except Exception as e:
            logger.error(f"Error loading data: {e}")
            return [], []
    
    async def _save_data(self, sections: List[Section], tasks: List[Task]):
        """Save sections and tasks to storage"""
        try:
            client = await self.thread_manager.db.client
            
            content = {
                'sections': [section.model_dump() for section in sections],
                'tasks': [task.model_dump() for task in tasks]
            }
            
            # Find existing message
            result = await client.table('messages').select('message_id')\
                .eq('thread_id', self.thread_id)\
                .eq('type', self.task_list_message_type)\
                .order('created_at', desc=True).limit(1).execute()
            
            if result.data:
                # Update existing
                await client.table('messages').update({'content': content})\
                    .eq('message_id', result.data[0]['message_id']).execute()
            else:
                # Create new
                await client.table('messages').insert({
                    'thread_id': self.thread_id,
                    'type': self.task_list_message_type,
                    'content': content,
                    'is_llm_message': False,
                    'metadata': {}
                }).execute()
            
        except Exception as e:
            logger.error(f"Error saving data: {e}")
            raise
    
    def _format_response(self, sections: List[Section], tasks: List[Task]) -> Dict[str, Any]:
        """Format data for response"""
        # Group display tasks by section
        section_map = {s.id: s for s in sections}
        grouped_tasks = {}
        
        for task in tasks:
            section_id = task.section_id
            if section_id not in grouped_tasks:
                grouped_tasks[section_id] = []
            grouped_tasks[section_id].append(task.model_dump())
        
        formatted_sections = []
        for section in sections:
            section_tasks = grouped_tasks.get(section.id, [])
            # Only include sections that have tasks to display (unless showing all sections)
            if section_tasks:
                formatted_sections.append({
                    "id": section.id,
                    "title": section.title,
                    "tasks": section_tasks
                })
        
        response = {
            "sections": formatted_sections,
            "total_tasks": len(tasks),  # Always use original task count
            "total_sections": len(sections)
        }
        
        return response

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "view_tasks",
            "description": "View all tasks and sections. Use this REGULARLY throughout execution to see current tasks, check progress, or review completed work. IMPORTANT: Use this tool every 2-3 task completions to check progress and identify the next task to execute in the sequential workflow. Always execute tasks in the exact order they appear, completing one task fully (with comprehensive research using multiple queries and sources) before moving to the next. Use this to determine which task is currently pending and should be tackled next. For research tasks, ensure each task receives thorough, in-depth research before marking complete. Before final output, use this to verify all tasks are marked complete. **🚨 PARAMETER NAMES**: This function takes no parameters.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
                "additionalProperties": False
            }
        }
    })
    async def view_tasks(self) -> ToolResult:
        """View all tasks and sections"""
        try:
            sections, tasks = await self._load_data()
            
            response_data = self._format_response(sections, tasks)
            
            return ToolResult(success=True, output=json.dumps(response_data, indent=2))
            
        except Exception as e:
            logger.error(f"Error viewing tasks: {e}")
            return ToolResult(success=False, output=f"❌ Error viewing tasks: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "create_tasks",
            "description": "Create tasks organized by sections. Supports both single section and multi-section batch creation. Creates sections automatically if they don't exist. USE ONLY FOR LARGE, COMPLEX TASKS: Only create task lists for substantial projects (10+ items, multi-phase work, large-scale research, complex multi-file projects). For research tasks involving many items, create SEPARATE individual tasks for EACH item to ensure deep, thorough research. Each research task should be comprehensive, requiring multiple queries and sources. Break down complex operations into granular, sequential tasks. Create tasks in the exact order they will be executed. Each task should represent a single, specific operation that can be completed independently. IMPORTANT: You can also use this tool DURING execution to add new tasks when you discover additional work is needed. You MUST specify either 'sections' array OR both 'task_contents' and ('section_title' OR 'section_id'). CRITICAL: The 'sections' parameter MUST be passed as an array of objects, NOT as a JSON string. Pass the actual array structure, not a stringified version. **🚨 PARAMETER NAMES**: Use EXACTLY these parameter names: `sections` (optional, batch mode), `section_title` (optional, single section), `section_id` (optional, single section), `task_contents` (optional, single section).",
            "parameters": {
                "type": "object",
                "properties": {
                    "sections": {
                        "type": "array",
                        "description": "**OPTIONAL** - List of sections with their tasks for batch creation. CRITICAL: This MUST be an array of objects (not a JSON string). Each element should be an object with title as a string and tasks as an array of strings.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "title": {
                                    "type": "string",
                                    "description": "Section title (creates if doesn't exist)"
                                },
                                "tasks": {
                                    "type": "array",
                                    "description": "Task contents for this section. Must be an array of strings, not a JSON string.",
                                    "items": {"type": "string"},
                                    "minItems": 1
                                }
                            },
                            "required": ["title", "tasks"]
                        }
                    },
                    "section_title": {
                        "type": "string",
                        "description": "**OPTIONAL** - Single section title (creates if doesn't exist). Use this OR sections array OR section_id."
                    },
                    "section_id": {
                        "type": "string",
                        "description": "**OPTIONAL** - Existing section ID. Use this OR sections array OR section_title."
                    },
                    "task_contents": {
                        "type": "array",
                        "description": "**OPTIONAL** - Task contents for single section creation (use with section_title or section_id). CRITICAL: This MUST be an array of strings, not a JSON string.",
                        "items": {"type": "string"}
                    }
                },
                "required": [],
                "additionalProperties": False
            }
        }
    })
    async def create_tasks(self, sections: Optional[List[Dict[str, Any]]] = None,
                          section_title: Optional[str] = None, section_id: Optional[str] = None,
                          task_contents: Optional[List[str]] = None) -> ToolResult:
        """Create tasks - supports both batch multi-section and single section creation"""
        try:
            # Parse sections if it's a JSON string (can happen when LLM passes it as string)
            if sections is not None:
                logger.debug(f"🔍 Received sections parameter: type={type(sections).__name__}")
                logger.debug(f"🔍 Sections repr: {repr(sections)[:500]}")
                logger.debug(f"🔍 Sections str: {str(sections)[:500]}")
                
                if isinstance(sections, str):
                    logger.debug(f"🔍 Sections is a string, attempting to parse...")
                    logger.debug(f"🔍 First 50 chars: {repr(sections[:50])}")
                    try:
                        sections = json.loads(sections)
                        logger.debug(f"✅ Parsed sections from JSON string: {len(sections) if isinstance(sections, list) else 'not a list'} items")
                    except json.JSONDecodeError as e:
                        logger.error(f"❌ Failed to parse sections JSON: {e}")
                        logger.error(f"❌ Raw value (first 500 chars): {repr(sections[:500])}")
                        return ToolResult(success=False, output=f"❌ Invalid JSON in sections parameter: {str(e)}")
                
                # Validate that sections is a list after parsing
                if not isinstance(sections, list):
                    return ToolResult(success=False, output=f"❌ Sections must be a list/array, got {type(sections).__name__}")
                
                # Validate structure of each section
                for idx, section_data in enumerate(sections):
                    if not isinstance(section_data, dict):
                        return ToolResult(success=False, output=f"❌ Section at index {idx} must be an object/dict, got {type(section_data).__name__}")
                    if "title" not in section_data:
                        return ToolResult(success=False, output=f"❌ Section at index {idx} is missing required 'title' field")
                    if "tasks" not in section_data:
                        return ToolResult(success=False, output=f"❌ Section at index {idx} is missing required 'tasks' field")
                    if not isinstance(section_data["tasks"], list):
                        return ToolResult(success=False, output=f"❌ Section '{section_data.get('title', 'unknown')}' tasks must be a list/array")
            
            # Parse task_contents if it's a JSON string
            if task_contents is not None and isinstance(task_contents, str):
                try:
                    task_contents = json.loads(task_contents)
                except json.JSONDecodeError as e:
                    return ToolResult(success=False, output=f"❌ Invalid JSON in task_contents parameter: {str(e)}")
                
                # Validate that task_contents is a list after parsing
                if not isinstance(task_contents, list):
                    return ToolResult(success=False, output=f"❌ Task_contents must be a list/array, got {type(task_contents).__name__}")
            
            existing_sections, existing_tasks = await self._load_data()
            section_map = {s.id: s for s in existing_sections}
            title_map = {s.title.lower(): s for s in existing_sections}
            
            created_tasks = 0
            created_sections = 0
            
            if sections:
                # Batch creation across multiple sections
                for section_data in sections:
                    section_title_input = section_data["title"]
                    task_list = section_data["tasks"]
                    
                    # Find or create section
                    title_lower = section_title_input.lower()
                    if title_lower in title_map:
                        target_section = title_map[title_lower]
                    else:
                        target_section = Section(title=section_title_input)
                        existing_sections.append(target_section)
                        title_map[title_lower] = target_section
                        created_sections += 1
                    
                    # Create tasks in this section
                    for task_content in task_list:
                        new_task = Task(content=task_content, section_id=target_section.id)
                        existing_tasks.append(new_task)
                        created_tasks += 1
                        
            else:
                # Single section creation - require explicit section specification
                if not task_contents:
                    return ToolResult(success=False, output="❌ Must provide either 'sections' array or 'task_contents' with section info")
                
                if not section_id and not section_title:
                    return ToolResult(success=False, output="❌ Must specify either 'section_id' or 'section_title' when using 'task_contents'")
                
                target_section = None
                
                if section_id:
                    # Use existing section ID
                    if section_id not in section_map:
                        return ToolResult(success=False, output=f"❌ Section ID '{section_id}' not found")
                    target_section = section_map[section_id]
                    
                elif section_title:
                    # Find or create section by title
                    title_lower = section_title.lower()
                    if title_lower in title_map:
                        target_section = title_map[title_lower]
                    else:
                        target_section = Section(title=section_title)
                        existing_sections.append(target_section)
                        created_sections += 1
                
                # Create tasks
                for content in task_contents:
                    new_task = Task(content=content, section_id=target_section.id)
                    existing_tasks.append(new_task)
                    created_tasks += 1
            
            await self._save_data(existing_sections, existing_tasks)
            
            response_data = self._format_response(existing_sections, existing_tasks)
            
            return ToolResult(success=True, output=json.dumps(response_data, indent=2))
            
        except Exception as e:
            logger.error(f"Error creating tasks: {e}")
            return ToolResult(success=False, output=f"❌ Error creating tasks: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "update_tasks",
            "description": "Update one or more tasks. CRITICAL: Mark tasks as 'completed' IMMEDIATELY after finishing each task - don't wait. This is essential for active task list management. EFFICIENT BATCHING: When you've completed multiple tasks, batch them into a single update call. Always execute tasks in the exact sequence they appear, but batch your updates when possible. You can also update task content if requirements change. Use this tool actively throughout execution to keep the task list current and accurate. **🚨 PARAMETER NAMES**: Use EXACTLY these parameter names: `task_ids` (REQUIRED), `content` (optional), `status` (optional), `section_id` (optional).",
            "parameters": {
                "type": "object",
                "properties": {
                    "task_ids": {
                        "oneOf": [
                            {"type": "string"},
                            {"type": "array", "items": {"type": "string"}, "minItems": 1}
                        ],
                        "description": "**REQUIRED** - Task ID (string) or array of task IDs to update. EFFICIENT APPROACH: Batch multiple completed tasks into a single call. CRITICAL: If passing an array, it MUST be an actual array of strings (not a JSON string)."
                    },
                    "content": {
                        "type": "string",
                        "description": "**OPTIONAL** - New content for the task(s)."
                    },
                    "status": {
                        "type": "string",
                        "enum": ["pending", "completed", "cancelled"],
                        "description": "**OPTIONAL** - New status for the task(s). Set to 'completed' for finished tasks. Batch multiple completed tasks when possible."
                    },
                    "section_id": {
                        "type": "string",
                        "description": "**OPTIONAL** - Section ID to move task(s) to."
                    }
                },
                "required": ["task_ids"],
                "additionalProperties": False
            }
        }
    })
    async def update_tasks(self, task_ids, content: Optional[str] = None,
                          status: Optional[str] = None, section_id: Optional[str] = None) -> ToolResult:
        """Update one or more tasks"""
        try:
            # Parse task_ids if it's a JSON string (can happen when LLM passes it as string)
            if task_ids is not None:
                if isinstance(task_ids, str):
                    # Try to parse as JSON array first
                    try:
                        parsed = json.loads(task_ids)
                        if isinstance(parsed, list):
                            target_task_ids = parsed
                        else:
                            # If not a list after parsing, treat as single ID
                            target_task_ids = [task_ids]
                    except (json.JSONDecodeError, ValueError):
                        # Not JSON, treat as single task ID string
                        target_task_ids = [task_ids]
                elif isinstance(task_ids, list):
                    target_task_ids = task_ids
                else:
                    # If it's neither string nor list, wrap it
                    target_task_ids = [task_ids]
            else:
                return ToolResult(success=False, output="❌ Task IDs are required")
            
            sections, tasks = await self._load_data()
            section_map = {s.id: s for s in sections}
            task_map = {t.id: t for t in tasks}
            
            # Validate all task IDs exist
            missing_tasks = [tid for tid in target_task_ids if tid not in task_map]
            if missing_tasks:
                return ToolResult(success=False, output=f"❌ Task IDs not found: {missing_tasks}")
            
            # Validate section ID if provided
            if section_id and section_id not in section_map:
                return ToolResult(success=False, output=f"❌ Section ID '{section_id}' not found")
            
            # Apply updates
            updated_count = 0
            for tid in target_task_ids:
                task = task_map[tid]
                
                if content is not None:
                    task.content = content
                if status is not None:
                    task.status = TaskStatus(status)
                if section_id is not None:
                    task.section_id = section_id
                
                updated_count += 1
            
            await self._save_data(sections, tasks)
            
            response_data = self._format_response(sections, tasks)
            
            return ToolResult(success=True, output=json.dumps(response_data, indent=2))
            
        except Exception as e:
            logger.error(f"Error updating tasks: {e}")
            return ToolResult(success=False, output=f"❌ Error updating tasks: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "delete_tasks",
            "description": "Delete one or more tasks and/or sections. Can delete tasks by their IDs or sections by their IDs (which will also delete all tasks in those sections). IMPORTANT: Use this tool DURING execution when tasks become unnecessary, redundant, or if requirements change. Active task list management includes removing tasks that are no longer needed. This helps keep the task list clean and focused on actual work remaining. **🚨 PARAMETER NAMES**: Use EXACTLY these parameter names: `task_ids` (optional), `section_ids` (optional), `confirm` (optional, required when deleting sections).",
            "parameters": {
                "type": "object",
                "properties": {
                    "task_ids": {
                        "oneOf": [
                            {"type": "string"},
                            {"type": "array", "items": {"type": "string"}, "minItems": 1}
                        ],
                        "description": "**OPTIONAL** - Task ID (string) or array of task IDs to delete. CRITICAL: If passing an array, it MUST be an actual array of strings (not a JSON string)."
                    },
                    "section_ids": {
                        "oneOf": [
                            {"type": "string"},
                            {"type": "array", "items": {"type": "string"}, "minItems": 1}
                        ],
                        "description": "**OPTIONAL** - Section ID (string) or array of section IDs to delete (will also delete all tasks in these sections). CRITICAL: If passing an array, it MUST be an actual array of strings (not a JSON string)."
                    },
                    "confirm": {
                        "type": "boolean",
                        "description": "**OPTIONAL** - Must be true to confirm deletion of sections. Required when deleting sections."
                    }
                },
                "required": [],
                "additionalProperties": False
            }
        }
    })
    async def delete_tasks(self, task_ids=None, section_ids=None, confirm: bool = False) -> ToolResult:
        """Delete one or more tasks and/or sections"""
        try:
            # Validate that at least one of task_ids or section_ids is provided
            if not task_ids and not section_ids:
                return ToolResult(success=False, output="❌ Must provide either task_ids or section_ids")
            
            # Validate confirm parameter for section deletion
            if section_ids and not confirm:
                return ToolResult(success=False, output="❌ Must set confirm=true to delete sections")
            
            sections, tasks = await self._load_data()
            section_map = {s.id: s for s in sections}
            task_map = {t.id: t for t in tasks}
            
            # Process task deletions
            deleted_tasks = 0
            remaining_tasks = tasks.copy()
            if task_ids:
                # Parse task_ids if it's a JSON string (can happen when LLM passes it as string)
                if isinstance(task_ids, str):
                    try:
                        parsed = json.loads(task_ids)
                        if isinstance(parsed, list):
                            target_task_ids = parsed
                        else:
                            target_task_ids = [task_ids]
                    except (json.JSONDecodeError, ValueError):
                        target_task_ids = [task_ids]
                elif isinstance(task_ids, list):
                    target_task_ids = task_ids
                else:
                    target_task_ids = [task_ids]
                
                # Validate all task IDs exist
                missing_tasks = [tid for tid in target_task_ids if tid not in task_map]
                if missing_tasks:
                    return ToolResult(success=False, output=f"❌ Task IDs not found: {missing_tasks}")
                
                # Remove tasks
                task_id_set = set(target_task_ids)
                remaining_tasks = [task for task in tasks if task.id not in task_id_set]
                deleted_tasks = len(tasks) - len(remaining_tasks)
            
            # Process section deletions
            deleted_sections = 0
            remaining_sections = sections.copy()
            if section_ids:
                # Parse section_ids if it's a JSON string (can happen when LLM passes it as string)
                if isinstance(section_ids, str):
                    try:
                        parsed = json.loads(section_ids)
                        if isinstance(parsed, list):
                            target_section_ids = parsed
                        else:
                            target_section_ids = [section_ids]
                    except (json.JSONDecodeError, ValueError):
                        target_section_ids = [section_ids]
                elif isinstance(section_ids, list):
                    target_section_ids = section_ids
                else:
                    target_section_ids = [section_ids]
                
                # Validate all section IDs exist
                missing_sections = [sid for sid in target_section_ids if sid not in section_map]
                if missing_sections:
                    return ToolResult(success=False, output=f"❌ Section IDs not found: {missing_sections}")
                
                # Remove sections and their tasks
                section_id_set = set(target_section_ids)
                remaining_sections = [s for s in sections if s.id not in section_id_set]
                remaining_tasks = [t for t in remaining_tasks if t.section_id not in section_id_set]
                deleted_sections = len(sections) - len(remaining_sections)
            
            await self._save_data(remaining_sections, remaining_tasks)
            
            response_data = self._format_response(remaining_sections, remaining_tasks)
            
            return ToolResult(success=True, output=json.dumps(response_data, indent=2))
            
        except Exception as e:
            logger.error(f"Error deleting tasks/sections: {e}")
            return ToolResult(success=False, output=f"❌ Error deleting tasks/sections: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "clear_all",
            "description": "Clear all tasks and sections (creates completely empty state). **🚨 PARAMETER NAMES**: Use EXACTLY this parameter name: `confirm` (REQUIRED).",
            "parameters": {
                "type": "object",
                "properties": {
                    "confirm": {
                        "type": "boolean",
                        "description": "**REQUIRED** - Must be true to confirm clearing everything."
                    }
                },
                "required": ["confirm"],
                "additionalProperties": False
            }
        }
    })
    async def clear_all(self, confirm: bool) -> ToolResult:
        """Clear everything and start fresh"""
        try:
            if not confirm:
                return ToolResult(success=False, output="❌ Must set confirm=true to clear all data")
            
            # Create completely empty state - no default section
            sections = []
            tasks = []
            
            await self._save_data(sections, tasks)
            
            response_data = self._format_response(sections, tasks)
            
            return ToolResult(success=True, output=json.dumps(response_data, indent=2))
            
        except Exception as e:
            logger.error(f"Error clearing all data: {e}")
            return ToolResult(success=False, output=f"❌ Error clearing all data: {str(e)}")