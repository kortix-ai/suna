from core.agentpress.tool import ToolResult, openapi_schema, usage_example
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

class TaskListTool(SandboxToolsBase):
    """Task management system for organizing and tracking tasks. It contains the action plan for the agent to follow.
    
    Features:
    - Create, update, and delete tasks organized by sections
    - Support for batch operations across multiple sections
    - Organize tasks into logical sections and workflows
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
            "description": "View all tasks and sections. Use this to see current tasks, check progress, or review completed work. IMPORTANT: This tool helps you identify the next task to execute in the sequential workflow. Always execute tasks in the exact order they appear, completing one task fully before moving to the next. Use this to determine which task is currently pending and should be tackled next.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }
    })
    @usage_example(
        '''
        <function_calls>
        <invoke name="view_tasks">
        </invoke>
        </function_calls>
        '''
    )
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
            "description": "Create tasks organized by sections. Supports both single section and multi-section batch creation. Creates sections automatically if they don't exist. IMPORTANT: Create tasks in the exact order they will be executed. Each task should represent a single, specific operation that can be completed independently. Break down complex operations into individual, sequential tasks to maintain the one-task-at-a-time execution principle. You MUST specify either 'sections' array OR both 'task_contents' and ('section_title' OR 'section_id').",
            "parameters": {
                "type": "object",
                "properties": {
                    "sections": {
                        "type": "array",
                        "description": "List of sections with their tasks for batch creation",
                        "items": {
                            "type": "object",
                            "properties": {
                                "title": {
                                    "type": "string",
                                    "description": "Section title (creates if doesn't exist)"
                                },
                                "tasks": {
                                    "type": "array",
                                    "description": "Task contents for this section",
                                    "items": {"type": "string"},
                                    "minItems": 1
                                }
                            },
                            "required": ["title", "tasks"]
                        }
                    },
                    "section_title": {
                        "type": "string",
                        "description": "Single section title (creates if doesn't exist - use this OR sections array)"
                    },
                    "section_id": {
                        "type": "string",
                        "description": "Existing section ID (use this OR sections array OR section_title)"
                    },
                    "task_contents": {
                        "type": "array",
                        "description": "Task contents for single section creation (use with section_title or section_id)",
                        "items": {"type": "string"}
                    }
                },
                "anyOf": [
                    {"required": ["sections"]},
                    {
                        "required": ["task_contents"],
                        "anyOf": [
                            {"required": ["section_title"]},
                            {"required": ["section_id"]}
                        ]
                    }
                ]
            }
        }
    })
    @usage_example(
        '''
        # Batch creation across multiple sections:
        <function_calls>
        <invoke name="create_tasks">
        <parameter name="sections">[
            {
                "title": "Setup & Planning", 
                "tasks": ["Research requirements", "Create project plan"]
            },
            {
                "title": "Development", 
                "tasks": ["Setup environment", "Write code", "Add tests"]
            },
            {
                "title": "Deployment", 
                "tasks": ["Deploy to staging", "Run tests", "Deploy to production"]
            }
        ]</parameter>
        </invoke>
        </function_calls>
        
        # Simple single section creation:
        <function_calls>
        <invoke name="create_tasks">
        <parameter name="section_title">Bug Fixes</parameter>
        <parameter name="task_contents">["Fix login issue", "Update error handling"]</parameter>
        </invoke>
        </function_calls>
        '''
    )
    async def create_tasks(self, sections: Optional[List[Dict[str, Any]]] = None,
                          section_title: Optional[str] = None, section_id: Optional[str] = None,
                          task_contents: Optional[List[str]] = None) -> ToolResult:
        """Create tasks - supports both batch multi-section and single section creation"""
        try:
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
                "description": "Update one or more tasks. EFFICIENT BATCHING: Before calling this tool, think about what tasks you have completed and batch them into a single update call. This is more efficient than making multiple consecutive update calls. Always execute tasks in the exact sequence they appear, but batch your updates when possible. Update task status to 'completed' after finishing each task, and consider batching multiple completed tasks into one call rather than updating them individually.",
            "parameters": {
                "type": "object",
                "properties": {
                    "task_ids": {
                        "oneOf": [
                            {"type": "string"},
                            {"type": "array", "items": {"type": "string"}, "minItems": 1}
                        ],
                        "description": "Task ID (string) or array of task IDs to update. EFFICIENT APPROACH: Batch multiple completed tasks into a single call rather than making multiple consecutive update calls. Always maintain sequential execution order."
                    },
                    "content": {
                        "type": "string",
                        "description": "New content for the task(s) (optional)"
                    },
                    "status": {
                        "type": "string",
                        "enum": ["pending", "completed", "cancelled"],
                        "description": "New status for the task(s) (optional). Set to 'completed' for finished tasks. Batch multiple completed tasks when possible."
                    },
                    "section_id": {
                        "type": "string",
                        "description": "Section ID to move task(s) to (optional)"
                    }
                },
                "required": ["task_ids"]
            }
        }
    })
    @usage_example(
        '''
        # Update single task (when only one task is completed):
        <function_calls>
        <invoke name="update_tasks">
        <parameter name="task_ids">task-uuid-here</parameter>
        <parameter name="status">completed</parameter>
        </invoke>
        </function_calls>
        
        # Update multiple tasks (EFFICIENT: batch multiple completed tasks):
        <function_calls>
        <invoke name="update_tasks">
        <parameter name="task_ids">["task-id-1", "task-id-2", "task-id-3"]</parameter>
        <parameter name="status">completed</parameter>
        </invoke>
        </function_calls>
        '''
    )
    async def update_tasks(self, task_ids, content: Optional[str] = None,
                          status: Optional[str] = None, section_id: Optional[str] = None) -> ToolResult:
        """Update one or more tasks"""
        try:
            # Normalize task_ids to always be a list
            if isinstance(task_ids, str):
                target_task_ids = [task_ids]
            else:
                target_task_ids = task_ids
            
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
            "description": "Delete one or more tasks and/or sections. Can delete tasks by their IDs or sections by their IDs (which will also delete all tasks in those sections).",
            "parameters": {
                "type": "object",
                "properties": {
                    "task_ids": {
                        "oneOf": [
                            {"type": "string"},
                            {"type": "array", "items": {"type": "string"}, "minItems": 1}
                        ],
                        "description": "Task ID (string) or array of task IDs to delete (optional)"
                    },
                    "section_ids": {
                        "oneOf": [
                            {"type": "string"},
                            {"type": "array", "items": {"type": "string"}, "minItems": 1}
                        ],
                        "description": "Section ID (string) or array of section IDs to delete (will also delete all tasks in these sections) (optional)"
                    },
                    "confirm": {
                        "type": "boolean",
                        "description": "Must be true to confirm deletion of sections (required when deleting sections)"
                    }
                },
                "anyOf": [
                    {"required": ["task_ids"]},
                    {"required": ["section_ids", "confirm"]}
                ]
            }
        }
    })
    @usage_example(
        '''
        # Delete single task:
        <function_calls>
        <invoke name="delete_tasks">
        <parameter name="task_ids">task-uuid-here</parameter>
        </invoke>
        </function_calls>
        
        # Delete multiple tasks:
        <function_calls>
        <invoke name="delete_tasks">
        <parameter name="task_ids">["task-id-1", "task-id-2"]</parameter>
        </invoke>
        </function_calls>
        
        # Delete single section (and all its tasks):
        <function_calls>
        <invoke name="delete_tasks">
        <parameter name="section_ids">section-uuid-here</parameter>
        <parameter name="confirm">true</parameter>
        </invoke>
        </function_calls>
        
        # Delete multiple sections (and all their tasks):
        <function_calls>
        <invoke name="delete_tasks">
        <parameter name="section_ids">["section-id-1", "section-id-2"]</parameter>
        <parameter name="confirm">true</parameter>
        </invoke>
        </function_calls>
        
        # Delete both tasks and sections:
        <function_calls>
        <invoke name="delete_tasks">
        <parameter name="task_ids">["task-id-1", "task-id-2"]</parameter>
        <parameter name="section_ids">["section-id-1"]</parameter>
        <parameter name="confirm">true</parameter>
        </invoke>
        </function_calls>
        '''
    )
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
                # Normalize task_ids to always be a list
                if isinstance(task_ids, str):
                    target_task_ids = [task_ids]
                else:
                    target_task_ids = task_ids
                
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
                # Normalize section_ids to always be a list
                if isinstance(section_ids, str):
                    target_section_ids = [section_ids]
                else:
                    target_section_ids = section_ids
                
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
            "description": "Clear all tasks and sections (creates completely empty state).",
            "parameters": {
                "type": "object",
                "properties": {
                    "confirm": {
                        "type": "boolean",
                        "description": "Must be true to confirm clearing everything"
                    }
                },
                "required": ["confirm"]
            }
        }
    })
    @usage_example(
        '''
        <function_calls>
        <invoke name="clear_all">
        <parameter name="confirm">true</parameter>
        </invoke>
        </function_calls>
        '''
    )
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