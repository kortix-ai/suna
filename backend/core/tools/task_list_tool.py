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
    display_name="Task Management",
    description="Create and track your action plan with organized to-do lists",
    icon="CheckSquare",
    color="bg-amber-100 dark:bg-amber-800/50",
    is_core=True,
    usage_guide="""
# AUTONOMOUS TASK EXECUTION MODE

The Task List is your ABSOLUTE SOURCE OF TRUTH for complex work. When operating in Autonomous Task Execution mode, the task list governs ALL your actions.

## WHEN TO ENTER AUTONOMOUS MODE

**USE TASK LIST FOR:**
- Multi-step projects (3+ distinct steps)
- Research involving multiple items (companies, countries, topics, products)
- Content creation (presentations, reports, multi-file projects)
- Data gathering and analysis
- Software development projects
- Any work requiring sustained execution over multiple turns

**SKIP TASK LIST FOR:**
- Simple questions answerable in one response
- Quick factual lookups
- Conversational exchanges
- Single-step operations

## THE TASK LIST CONTRACT

When a task list exists, you are bound by these rules:

### 1. SEQUENTIAL EXECUTION - NO EXCEPTIONS
- Execute tasks in EXACT order they appear
- NEVER skip tasks or work out of order
- NEVER start task N+1 before completing task N
- The sequence is sacred - it represents your plan of attack

### 2. IMMEDIATE STATUS UPDATES
- Mark tasks `completed` THE MOMENT you finish them
- Don't batch updates at the end - update as you go
- This creates a real-time progress trail
- Use `view_tasks` after every 2-3 completions to verify state

### 3. UNINTERRUPTED EXECUTION
- Once started, execute ALL tasks to completion
- NEVER ask "should I continue?" between tasks
- NEVER pause for confirmation mid-execution
- The user approved by initiating - no further permission needed
- Only stop if genuinely blocked by missing information

### 4. LIVING DOCUMENT MANAGEMENT
- ADD tasks when you discover additional work needed
- REMOVE tasks that become unnecessary
- UPDATE task content if scope changes
- The task list evolves with your understanding

## TASK BREAKDOWN PRINCIPLES

### Granularity - One Unit of Work Per Task
Each task should represent ONE distinct operation:
- ❌ BAD: "Research 5 companies and create comparison"
- ✅ GOOD: 5 tasks (one per company) + 1 synthesis task

### Specificity - Clear Completion Criteria
Each task should have obvious "done" state:
- ❌ BAD: "Look into market trends"
- ✅ GOOD: "Research Company A: strategy, funding, market position, recent news"

### Depth - Comprehensive Research Per Task
Each research task requires:
- Multiple search queries (use batch mode)
- Cross-reference 2-3+ sources
- Verify from authoritative sources
- Document findings with citations

## TASK LIST STRUCTURE

Organize into logical phases:

```
Section: "Research Phase"
- Task: "Research Item A: [specific aspects]"
- Task: "Research Item B: [specific aspects]"
...

Section: "Analysis Phase"  
- Task: "Cross-reference findings, verify accuracy"
- Task: "Identify patterns and insights"

Section: "Output Phase"
- Task: "Create deliverable (report/presentation/dashboard)"
- Task: "Document sources and methodology"
```

## EXECUTION WORKFLOW

### Phase 1: Planning
1. Analyze the request - identify all discrete work items
2. Create comprehensive task list with granular tasks
3. Organize into logical sections/phases
4. Initialize any needed JIT tools

### Phase 2: Execution Loop
```
WHILE pending tasks exist:
    1. view_tasks → identify next pending task
    2. Execute task thoroughly (multiple queries, sources)
    3. update_tasks → mark completed IMMEDIATELY
    4. IF discovered new work → create_tasks to add
    5. IF task unnecessary → delete_tasks to remove
```

### Phase 3: Completion
1. view_tasks → verify ALL tasks completed
2. Compile final deliverables
3. Call `complete` with all attachments

## RESEARCH QUALITY STANDARDS

For each research item:
- **Breadth**: Search for current state, future plans, funding, official sources
- **Depth**: Don't accept first result - dig deeper
- **Verification**: Cross-reference 2-3+ authoritative sources
- **Documentation**: Record sources for citation

Use batch search mode for efficiency:
```
web_search(queries=[
    "Company X market strategy 2024",
    "Company X recent funding",
    "Company X competitive positioning",
    "Company X official announcements"
])
```

## AUTO-EXTRACTION PATTERN

After each web_search:
1. Identify high-quality sources in results
2. Use `scrape_webpage` to extract full content from promising URLs
3. For academic sources, use `get_paper_details`
4. Read extracted content thoroughly - never rely on snippets alone

## EXAMPLE: Multi-Company Research

**Request:** "Compare market strategies of 5 tech companies"

**Task List:**
```
Section: "Individual Company Research"
- Research Apple: market strategy, recent initiatives, target segments, competitive moves
- Research Google: market strategy, recent initiatives, target segments, competitive moves  
- Research Microsoft: market strategy, recent initiatives, target segments, competitive moves
- Research Amazon: market strategy, recent initiatives, target segments, competitive moves
- Research Meta: market strategy, recent initiatives, target segments, competitive moves

Section: "Verification & Analysis"
- Cross-reference findings across sources, verify accuracy
- Identify common patterns and unique differentiators

Section: "Deliverables"
- Create comparison table (CSV + formatted report)
- Create executive summary with key insights
```

**Execution:**
1. Create task list ✓
2. Research Apple (4+ queries, 3+ sources) → mark complete
3. Research Google (4+ queries, 3+ sources) → mark complete
4. ... continue for each company
5. Cross-reference and verify → mark complete
6. Create deliverables → mark complete
7. Call `complete` with all files attached

## CONTEXT MANAGEMENT FOR LONG SESSIONS

You operate as a long-running agent. Over extended sessions:

### Maintain State Awareness
- Regularly `view_tasks` to anchor yourself
- The task list IS your memory of what's been done
- Reference completed tasks to avoid redundant work

### Handle Context Limits
- Task list persists even if conversation context shifts
- Always check task list state at session start
- Completed tasks represent verified progress

### Progress Tracking
- Task completion creates audit trail
- Users can see progress in real-time
- Status updates communicate without interrupting

## MULTI-STEP TASK EXECUTION RULES

Once a multi-phase task begins:

1. **NO INTERRUPTIONS** - Execute all steps to completion
2. **NO PERMISSION SEEKING** - User approved by starting
3. **NO SCOPE CREEP** - Stick to the plan
4. **CONTINUOUS UPDATES** - Mark progress as you go
5. **QUALITY OVER SPEED** - Thorough research per task

## VISUALIZATION & OUTPUT STANDARDS

When creating data outputs:
- Export data as CSV/JSON (single source of truth)
- Create interactive dashboards that LOAD from data files
- Never hardcode data in visualization code
- Both data file and dashboard are deliverables

## TOOL INITIALIZATION PATTERN

Before execution, initialize needed tools:
1. Assess which JIT tools are needed
2. Call `initialize_tools` for each
3. Then begin task execution
4. Never pause mid-execution to initialize

## SUMMARY: AUTONOMOUS MODE CHECKLIST

Before starting:
- [ ] Is this complex enough for a task list? (3+ steps, multiple items)
- [ ] Have I created granular, specific tasks?
- [ ] Are tasks in correct execution order?
- [ ] Have I initialized all needed tools?

During execution:
- [ ] Am I executing tasks in order?
- [ ] Am I marking complete IMMEDIATELY after each?
- [ ] Am I using `view_tasks` regularly?
- [ ] Am I researching deeply (multiple queries, sources)?

After completion:
- [ ] Are ALL tasks marked complete?
- [ ] Have I attached all deliverables?
- [ ] Did I include follow_up_prompts?
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
