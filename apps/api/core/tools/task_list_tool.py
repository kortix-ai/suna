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
    section_id: str

@tool_metadata(
    display_name="TodoWrite",
    description="Create and manage a structured task list for your current session",
    icon="CheckSquare",
    color="bg-amber-100 dark:bg-amber-800/50",
    is_core=True,
    usage_guide="""
## TodoWrite - Structured task list management

Use this tool to create and manage a structured task list for your current session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user. It also helps the user understand the progress of the task and overall progress of their requests.

### Available Tools
- **create_tasks**: Create task list with sections and tasks
- **view_tasks**: View current state and progress
- **update_tasks**: Mark tasks completed or update content
- **delete_tasks**: Remove tasks or sections
- **clear_all**: Reset task list to empty state

### When to Use This Tool
Use this tool proactively in these scenarios:

1. **Complex multi-step tasks** - When a task requires 3 or more distinct steps or actions
2. **Non-trivial and complex tasks** - Tasks that require careful planning or multiple operations
3. **User explicitly requests todo list** - When the user directly asks you to use the todo list
4. **User provides multiple tasks** - When users provide a list of things to be done (numbered or comma-separated)
5. **After receiving new instructions** - Immediately capture user requirements as todos
6. **When you start working on a task** - Mark it as in_progress BEFORE beginning work. Ideally you should only have one todo as in_progress at a time
7. **After completing a task** - Mark it as completed and add any new follow-up tasks discovered during implementation

### When NOT to Use This Tool
Skip using this tool when:
1. There is only a single, straightforward task
2. The task is trivial and tracking it provides no organizational benefit
3. The task can be completed in less than 3 trivial steps
4. The task is purely conversational or informational

NOTE: Do not use this tool if there is only one trivial task to do. Just do the task directly.

### Task States and Management

**Task States:** Use these states to track progress:
- pending: Task not yet started
- in_progress: Currently working on (limit to ONE task at a time)
- completed: Task finished successfully

**IMPORTANT:** Task descriptions must have two forms:
- content: The imperative form describing what needs to be done (e.g., "Run tests", "Build the project")
- activeForm: The present continuous form shown during execution (e.g., "Running tests", "Building the project")

### Task Management Rules

1. Update task status in real-time as you work
2. Mark tasks complete IMMEDIATELY after finishing (don't batch completions)
3. Exactly ONE task must be in_progress at any time (not less, not more)
4. Complete current tasks before starting new ones
5. Remove tasks that are no longer relevant from the list entirely

### Task Completion Requirements

- ONLY mark a task as completed when you have FULLY accomplished it
- If you encounter errors, blockers, or cannot finish, keep the task as in_progress
- When blocked, create a new task describing what needs to be resolved
- Never mark a task as completed if:
  - Tests are failing
  - Implementation is partial
  - You encountered unresolved errors
  - You couldn't find necessary files or dependencies

### Task Breakdown

- Create specific, actionable items
- Break complex tasks into smaller, manageable steps
- Use clear, descriptive task names
- Always provide both forms:
  - content: "Fix authentication bug"
  - activeForm: "Fixing authentication bug"

When in doubt, use this tool. Being proactive with task management demonstrates attentiveness and ensures you complete all requirements successfully.
""",
    weight=5,
    visible=True
)

class TaskListTool(SandboxToolsBase):
    """Task management system - the source of truth for Autonomous Task Execution mode.
    
    The task list governs all complex work:
    - Sequential execution of tasks in order
    - Immediate status updates as work progresses
    - Living document that evolves with the work
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
                    for old_section in content['sections']:
                        section = Section(title=old_section['title'])
                        sections.append(section)
                        
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
            
            result = await client.table('messages').select('message_id')\
                .eq('thread_id', self.thread_id)\
                .eq('type', self.task_list_message_type)\
                .order('created_at', desc=True).limit(1).execute()
            
            if result.data:
                await client.table('messages').update({'content': content})\
                    .eq('message_id', result.data[0]['message_id']).execute()
            else:
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
            if section_tasks:
                formatted_sections.append({
                    "id": section.id,
                    "title": section.title,
                    "tasks": section_tasks
                })
        
        # Calculate progress
        completed = sum(1 for t in tasks if t.status == TaskStatus.COMPLETED)
        pending = sum(1 for t in tasks if t.status == TaskStatus.PENDING)
        
        return {
            "sections": formatted_sections,
            "total_tasks": len(tasks),
            "completed_tasks": completed,
            "pending_tasks": pending,
            "progress_percent": round((completed / len(tasks) * 100) if tasks else 0, 1),
            "total_sections": len(sections)
        }

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "view_tasks",
            "description": "View current task list state. Use REGULARLY during execution to: 1) Identify next pending task, 2) Verify progress, 3) Anchor yourself in long sessions. The task list is your source of truth - check it often.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
                "additionalProperties": False
            }
        }
    })
    async def view_tasks(self) -> ToolResult:
        """View all tasks and sections with progress summary"""
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
            "description": "Create task list for Autonomous Task Execution mode. Creates sections and tasks that become your execution plan. Each task = one unit of work. Tasks execute in order. Use BEFORE starting complex work, or DURING execution to add discovered work.",
            "parameters": {
                "type": "object",
                "properties": {
                    "sections": {
                        "type": "array",
                        "description": "Sections with their tasks. Each section groups related tasks (e.g., 'Research Phase', 'Analysis Phase').",
                        "items": {
                            "type": "object",
                            "properties": {
                                "title": {"type": "string", "description": "Section title"},
                                "tasks": {
                                    "type": "array",
                                    "items": {"type": "string"},
                                    "description": "Task descriptions for this section",
                                    "minItems": 1
                                }
                            },
                            "required": ["title", "tasks"]
                        }
                    },
                    "section_title": {
                        "type": "string",
                        "description": "Single section title (alternative to sections array)"
                    },
                    "section_id": {
                        "type": "string",
                        "description": "Add tasks to existing section by ID"
                    },
                    "task_contents": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Task descriptions (use with section_title or section_id)"
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
        """Create tasks - supports batch multi-section and single section creation"""
        try:
            # Parse JSON strings if needed
            if sections is not None and isinstance(sections, str):
                    try:
                        sections = json.loads(sections)
                    except json.JSONDecodeError as e:
                        from core.utils.json_helpers import repair_json
                        repaired, was_repaired = repair_json(sections)
                        if was_repaired:
                            try:
                                sections = json.loads(repaired)
                            except json.JSONDecodeError as e2:
                                return ToolResult(success=False, output=f"❌ Invalid JSON in sections: {str(e)}")
                        else:
                            return ToolResult(success=False, output=f"❌ Invalid JSON in sections: {str(e)}")
                
            if sections is not None and not isinstance(sections, list):
                return ToolResult(success=False, output=f"❌ Sections must be an array, got {type(sections).__name__}")
                
            if sections:
                for idx, section_data in enumerate(sections):
                    if not isinstance(section_data, dict):
                        return ToolResult(success=False, output=f"❌ Section {idx} must be an object")
                    if "title" not in section_data or "tasks" not in section_data:
                        return ToolResult(success=False, output=f"❌ Section {idx} missing 'title' or 'tasks'")
                    if not isinstance(section_data["tasks"], list):
                        return ToolResult(success=False, output=f"❌ Section '{section_data.get('title')}' tasks must be an array")
            
            if task_contents is not None and isinstance(task_contents, str):
                try:
                    task_contents = json.loads(task_contents)
                except json.JSONDecodeError as e:
                    from core.utils.json_helpers import repair_json
                    repaired, was_repaired = repair_json(task_contents)
                    if was_repaired:
                        try:
                            task_contents = json.loads(repaired)
                        except:
                            return ToolResult(success=False, output=f"❌ Invalid JSON in task_contents")
                    else:
                        return ToolResult(success=False, output=f"❌ Invalid JSON in task_contents")
            
            existing_sections, existing_tasks = await self._load_data()
            section_map = {s.id: s for s in existing_sections}
            title_map = {s.title.lower(): s for s in existing_sections}
            
            created_tasks = 0
            created_sections = 0
            
            if sections:
                for section_data in sections:
                    section_title_input = section_data["title"]
                    task_list = section_data["tasks"]
                    
                    title_lower = section_title_input.lower()
                    if title_lower in title_map:
                        target_section = title_map[title_lower]
                    else:
                        target_section = Section(title=section_title_input)
                        existing_sections.append(target_section)
                        title_map[title_lower] = target_section
                        created_sections += 1
                    
                    for task_content in task_list:
                        new_task = Task(content=task_content, section_id=target_section.id)
                        existing_tasks.append(new_task)
                        created_tasks += 1
                        
            else:
                if not task_contents:
                    return ToolResult(success=False, output="❌ Provide 'sections' array OR 'task_contents' with section info")
                
                if not section_id and not section_title:
                    return ToolResult(success=False, output="❌ Specify 'section_id' or 'section_title' with 'task_contents'")
                
                target_section = None
                
                if section_id:
                    if section_id not in section_map:
                        return ToolResult(success=False, output=f"❌ Section ID '{section_id}' not found")
                    target_section = section_map[section_id]
                elif section_title:
                    title_lower = section_title.lower()
                    if title_lower in title_map:
                        target_section = title_map[title_lower]
                    else:
                        target_section = Section(title=section_title)
                        existing_sections.append(target_section)
                        created_sections += 1
                
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
            "description": "Update task status or content. CRITICAL: Mark tasks 'completed' IMMEDIATELY after finishing each - don't wait. Batch multiple completions when efficient. This maintains accurate progress state.",
            "parameters": {
                "type": "object",
                "properties": {
                    "task_ids": {
                        "oneOf": [
                            {"type": "string"},
                            {"type": "array", "items": {"type": "string"}, "minItems": 1}
                        ],
                        "description": "**REQUIRED** - Task ID(s) to update. Batch multiple IDs for efficiency."
                    },
                    "content": {
                        "type": "string",
                        "description": "New content for the task(s)"
                    },
                    "status": {
                        "type": "string",
                        "enum": ["pending", "completed", "cancelled"],
                        "description": "New status. Use 'completed' when task is done."
                    },
                    "section_id": {
                        "type": "string",
                        "description": "Move task(s) to different section"
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
            # Parse task_ids
            if task_ids is not None:
                if isinstance(task_ids, str):
                    try:
                        parsed = json.loads(task_ids)
                        target_task_ids = parsed if isinstance(parsed, list) else [task_ids]
                    except (json.JSONDecodeError, ValueError):
                        target_task_ids = [task_ids]
                elif isinstance(task_ids, list):
                    target_task_ids = task_ids
                else:
                    target_task_ids = [task_ids]
            else:
                return ToolResult(success=False, output="❌ Task IDs required")
            
            sections, tasks = await self._load_data()
            section_map = {s.id: s for s in sections}
            task_map = {t.id: t for t in tasks}
            
            missing_tasks = [tid for tid in target_task_ids if tid not in task_map]
            if missing_tasks:
                return ToolResult(success=False, output=f"❌ Task IDs not found: {missing_tasks}")
            
            if section_id and section_id not in section_map:
                return ToolResult(success=False, output=f"❌ Section ID '{section_id}' not found")
            
            for tid in target_task_ids:
                task = task_map[tid]
                if content is not None:
                    task.content = content
                if status is not None:
                    task.status = TaskStatus(status)
                if section_id is not None:
                    task.section_id = section_id
            
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
            "description": "Remove tasks or sections that are no longer needed. Use during execution when tasks become unnecessary or redundant. Keeps task list clean and focused.",
            "parameters": {
                "type": "object",
                "properties": {
                    "task_ids": {
                        "oneOf": [
                            {"type": "string"},
                            {"type": "array", "items": {"type": "string"}, "minItems": 1}
                        ],
                        "description": "Task ID(s) to delete"
                    },
                    "section_ids": {
                        "oneOf": [
                            {"type": "string"},
                            {"type": "array", "items": {"type": "string"}, "minItems": 1}
                        ],
                        "description": "Section ID(s) to delete (deletes all tasks in section)"
                    },
                    "confirm": {
                        "type": "boolean",
                        "description": "Must be true to delete sections"
                    }
                },
                "required": [],
                "additionalProperties": False
            }
        }
    })
    async def delete_tasks(self, task_ids=None, section_ids=None, confirm: bool = False) -> ToolResult:
        """Delete tasks and/or sections"""
        try:
            if not task_ids and not section_ids:
                return ToolResult(success=False, output="❌ Provide task_ids or section_ids")
            
            if section_ids and not confirm:
                return ToolResult(success=False, output="❌ Set confirm=true to delete sections")
            
            sections, tasks = await self._load_data()
            section_map = {s.id: s for s in sections}
            task_map = {t.id: t for t in tasks}
            
            remaining_tasks = tasks.copy()
            remaining_sections = sections.copy()
            
            if task_ids:
                if isinstance(task_ids, str):
                    try:
                        parsed = json.loads(task_ids)
                        target_task_ids = parsed if isinstance(parsed, list) else [task_ids]
                    except (json.JSONDecodeError, ValueError):
                        target_task_ids = [task_ids]
                elif isinstance(task_ids, list):
                    target_task_ids = task_ids
                else:
                    target_task_ids = [task_ids]
                
                missing = [tid for tid in target_task_ids if tid not in task_map]
                if missing:
                    return ToolResult(success=False, output=f"❌ Task IDs not found: {missing}")
                
                task_id_set = set(target_task_ids)
                remaining_tasks = [t for t in tasks if t.id not in task_id_set]
            
            if section_ids:
                if isinstance(section_ids, str):
                    try:
                        parsed = json.loads(section_ids)
                        target_section_ids = parsed if isinstance(parsed, list) else [section_ids]
                    except (json.JSONDecodeError, ValueError):
                        target_section_ids = [section_ids]
                elif isinstance(section_ids, list):
                    target_section_ids = section_ids
                else:
                    target_section_ids = [section_ids]
                
                missing = [sid for sid in target_section_ids if sid not in section_map]
                if missing:
                    return ToolResult(success=False, output=f"❌ Section IDs not found: {missing}")
                
                section_id_set = set(target_section_ids)
                remaining_sections = [s for s in sections if s.id not in section_id_set]
                remaining_tasks = [t for t in remaining_tasks if t.section_id not in section_id_set]
            
            await self._save_data(remaining_sections, remaining_tasks)
            response_data = self._format_response(remaining_sections, remaining_tasks)
            
            return ToolResult(success=True, output=json.dumps(response_data, indent=2))
            
        except Exception as e:
            logger.error(f"Error deleting: {e}")
            return ToolResult(success=False, output=f"❌ Error deleting: {str(e)}")

    @openapi_schema({
        "type": "function",
        "function": {
            "name": "clear_all",
            "description": "Reset task list to empty state. Use when starting fresh or abandoning current plan.",
            "parameters": {
                "type": "object",
                "properties": {
                    "confirm": {
                        "type": "boolean",
                        "description": "**REQUIRED** - Must be true to confirm"
                    }
                },
                "required": ["confirm"],
                "additionalProperties": False
            }
        }
    })
    async def clear_all(self, confirm: bool) -> ToolResult:
        """Clear all tasks and sections"""
        try:
            if not confirm:
                return ToolResult(success=False, output="❌ Set confirm=true to clear")
            
            await self._save_data([], [])
            return ToolResult(success=True, output=json.dumps({
                "sections": [],
                "total_tasks": 0,
                "completed_tasks": 0,
                "pending_tasks": 0,
                "progress_percent": 0,
                "total_sections": 0
            }, indent=2))
            
        except Exception as e:
            logger.error(f"Error clearing: {e}")
            return ToolResult(success=False, output=f"❌ Error clearing: {str(e)}")
