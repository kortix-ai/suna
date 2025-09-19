import json
from typing import Dict, List, Any, Optional
from datetime import datetime, timezone
import croniter
import pytz
from core.utils.logger import logger

class TriggerError(Exception):
    pass


class ConfigurationError(TriggerError):
    pass


class ProviderError(TriggerError):
    pass


class WorkflowParser:
    def __init__(self):
        self.step_counter = 0
    
    def parse_workflow_steps(self, steps: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        self.step_counter = 0
        
        start_node = next(
            (step for step in steps if step.get('name') == 'Start' and step.get('description') == 'Click to add steps or use the Add Node button'),
            None
        )

        if start_node and "children" in start_node:
            filtered_steps = start_node["children"]
        else:
            # fallback: use top-level list (for backward compat)
            filtered_steps = steps
        
        return self._parse_steps_recursive(filtered_steps)
    
    def _parse_steps_recursive(self, steps: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        result = []
        processed_ids = set()
        
        for step in steps:
            step_id = step.get('id')
            
            # Skip if already processed as part of a conditional group
            if step_id in processed_ids:
                continue
            
            step_type = step.get('type')
            parent_conditional_id = step.get('parentConditionalId')
            
            if step_type == 'condition' and not parent_conditional_id:
                # This is a root conditional step - find all its siblings
                conditional_group = [step]
                
                # Find all siblings (steps with parentConditionalId pointing to this step)
                for other_step in steps:
                    if other_step.get('parentConditionalId') == step_id:
                        conditional_group.append(other_step)
                
                # Sort by condition type (if, elseif, else)
                conditional_group.sort(key=lambda s: self._get_condition_order(s))
                
                # Parse the conditional group as an instruction step with conditions
                parsed_group = self._parse_conditional_group(conditional_group)
                if parsed_group:
                    result.append(parsed_group)
                
                # Mark all steps in group as processed
                for group_step in conditional_group:
                    processed_ids.add(group_step.get('id'))
                    
            elif step_type == 'condition' and parent_conditional_id:
                # This step belongs to a parent conditional - skip it
                # It will be processed when we encounter the parent
                continue
                
            else:
                # Regular instruction step
                parsed_step = self._parse_single_step(step)
                if parsed_step:
                    result.append(parsed_step)
                processed_ids.add(step_id)
        
        return result
    
    def _get_condition_order(self, step: Dict[str, Any]) -> int:
        """Sort order for conditions: if=0, elseif=1, else=2"""
        condition_type = step.get('conditions', {}).get('type', 'if')
        return {'if': 0, 'elseif': 1, 'else': 2}.get(condition_type, 0)
    
    def _parse_conditional_group(self, conditional_group: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Parse a group of related conditional steps (if/elseif/else) as one instruction step"""
        if not conditional_group:
            return None
            
        self.step_counter += 1
        
        # Use first step's name or generate one
        first_step = conditional_group[0]
        step_name = first_step.get('name', f'Conditional Step {self.step_counter}')
        
        parsed_step = {
            "step": step_name,
            "step_number": self.step_counter
        }
        
        # Add description if meaningful
        description = first_step.get('description', '').strip()
        if description and description not in ['Add conditional logic', 'If/Then']:
            parsed_step["description"] = description
        
        # Parse all conditions in the group
        conditions = []
        for condition_step in conditional_group:
            parsed_condition = self._parse_condition_step(condition_step)
            if parsed_condition:
                conditions.append(parsed_condition)
        
        if conditions:
            parsed_step["conditions"] = conditions
        
        return parsed_step
    
    def _parse_single_step(self, step: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        step_type = step.get('type')
        
        if step_type == 'instruction':
            return self._parse_instruction_step(step)
        else:
            # For non-instruction steps, treat as instruction by default
            return self._parse_instruction_step(step)
    
    def _parse_instruction_step(self, step: Dict[str, Any]) -> Dict[str, Any]:
        self.step_counter += 1
        
        parsed_step = {
            "step": step.get('name', f'Step {self.step_counter}'),
            "step_number": self.step_counter
        }
        
        description = step.get('description', '').strip()
        if description and description not in ['Click to add steps or use the Add Node button', 'Add conditional logic', 'Add a custom instruction step']:
            parsed_step["description"] = description
        
        tool_name = step.get('config', {}).get('tool_name')
        if tool_name:
            if ':' in tool_name:
                _, clean_tool_name = tool_name.split(':', 1)
                parsed_step["tool"] = clean_tool_name
            else:
                parsed_step["tool"] = tool_name
        
        children = step.get('children', [])
        if children:
            parsed_children = self._parse_steps_recursive(children)
            
            # Group children by type - conditions vs regular steps
            condition_children = []
            instruction_children = []
            
            for child in parsed_children:
                if child.get('condition'):  # This is a condition
                    condition_children.append(child)
                else:  # This is a regular step
                    instruction_children.append(child)
            
            if condition_children:
                parsed_step["conditions"] = condition_children
            
            if instruction_children:
                parsed_step["then"] = instruction_children
        
        return parsed_step
    
    def _parse_condition_step(self, step: Dict[str, Any]) -> Dict[str, Any]:
        conditions = step.get('conditions', {})
        condition_type = conditions.get('type', 'if')
        expression = conditions.get('expression', '').strip()
        
        parsed_condition = {}
        
        if condition_type == 'if':
            parsed_condition["condition"] = expression if expression else "true"
        elif condition_type == 'elseif':
            parsed_condition["condition"] = f"else if {expression}" if expression else "else if true"
        elif condition_type == 'else':
            parsed_condition["condition"] = "else"
        
        children = step.get('children', [])
        if children:
            parsed_condition["then"] = self._parse_steps_recursive(children)
        
        return parsed_condition
    
    def get_workflow_summary(self, steps: List[Dict[str, Any]]) -> Dict[str, Any]:
        def count_steps_recursive(steps_list):
            count = 0
            conditions_count = 0
            max_depth = 0
            
            for step in steps_list:
                if "step_number" in step:
                    count += 1
                
                if "conditions" in step:
                    conditions_count += len(step["conditions"])
                    for condition in step["conditions"]:
                        if "then" in condition:
                            sub_count, sub_conditions, sub_depth = count_steps_recursive(condition["then"])
                            count += sub_count
                            conditions_count += sub_conditions
                            max_depth = max(max_depth, sub_depth + 1)
                
                if "then" in step:
                    sub_count, sub_conditions, sub_depth = count_steps_recursive(step["then"])
                    count += sub_count
                    conditions_count += sub_conditions
                    max_depth = max(max_depth, sub_depth + 1)
            
            return count, conditions_count, max_depth
        
        total_steps, total_conditions, max_nesting_depth = count_steps_recursive(steps)
        
        # Parse the workflow to see the actual output
        parsed_steps = self.parse_workflow_steps(steps)
        
   
        
        return {
            "total_steps": total_steps,
            "total_conditions": total_conditions,
            "max_nesting_depth": max_nesting_depth,
            "has_conditional_logic": total_conditions > 0
        }


def format_workflow_for_llm(
    workflow_config: Dict[str, Any],
    steps: List[Dict[str, Any]],
    input_data: Dict[str, Any] = None,
    available_tools: List[str] = None
) -> str:
    # If this is a playbook, format with the simplified playbook prompt
    if is_playbook(steps):
        return format_playbook_for_llm(workflow_config, steps, input_data, available_tools)

    # Legacy/regular workflow formatting
    parser = WorkflowParser()
    parsed_steps = parser.parse_workflow_steps(steps)
    summary = parser.get_workflow_summary(parsed_steps)
    
    llm_workflow = {
        "workflow": workflow_config.get('name', 'Untitled Workflow'),
        "steps": parsed_steps
    }

    if workflow_config.get('description'):
        llm_workflow["description"] = workflow_config['description']
    
    llm_workflow["summary"] = summary
    
    workflow_json = json.dumps(llm_workflow, indent=2)
    tools_list = ', '.join(available_tools) if available_tools else 'Use any available tools from your system prompt'
    input_json = json.dumps(input_data, indent=2) if input_data else 'None provided'
   
    return f"""You are executing a structured workflow. Follow the steps exactly as specified in the JSON below.

WORKFLOW STRUCTURE:
{workflow_json}

EXECUTION INSTRUCTIONS:
1. Execute each step in the order presented
2. For steps with a "tool" field, you MUST use that specific tool
3. For steps with "conditions" field:
   - Evaluate each condition in order
   - Execute the "then" steps for the first condition that evaluates to true
   - For "else" conditions, execute if no previous conditions were true
4. Provide clear progress updates as you complete each step
5. If a tool is not available, explain what you would do instead

WORKFLOW STATISTICS:
- Total Steps: {summary['total_steps']}
- Conditional Branches: {summary['total_conditions']}
- Maximum Nesting Depth: {summary['max_nesting_depth']}
- Has Conditional Logic: {summary['has_conditional_logic']}

AVAILABLE TOOLS:
{tools_list}

IMPORTANT TOOL USAGE:
- When a step specifies a tool, that tool MUST be used
- If the specified tool is not available, explain what you would do instead
- Use only the tools that are listed as available

WORKFLOW INPUT DATA:
{input_json}

Begin executing the workflow now, starting with the first step."""


def is_playbook(steps: List[Dict[str, Any]]) -> bool:
    try:
        if not steps:
            return False
        start_node = next(
            (s for s in steps if s.get('name') == 'Start' and s.get('description') == 'Click to add steps or use the Add Node button'),
            None
        )
        candidate = None
        if start_node and isinstance(start_node.get('children'), list) and start_node['children']:
            candidate = start_node['children'][0]
        else:
            candidate = steps[0]
        return bool(candidate and isinstance(candidate.get('config'), dict) and candidate['config'].get('playbook'))
    except Exception:
        return False


def format_playbook_for_llm(
    workflow_config: Dict[str, Any],
    steps: List[Dict[str, Any]],
    input_data: Optional[Dict[str, Any]] = None,
    available_tools: Optional[List[str]] = None
) -> str:
    # Extract template and variables from the playbook structure
    # Prefer template from playbook step; fall back to workflow description
    template: str = ''
    variables: List[str] = []

    try:
        start_node = next(
            (s for s in steps if s.get('name') == 'Start' and s.get('description') == 'Click to add steps or use the Add Node button'),
            None
        )
        candidate = None
        if start_node and isinstance(start_node.get('children'), list) and start_node['children']:
            candidate = start_node['children'][0]
        else:
            candidate = steps[0]

        playbook_cfg = candidate.get('config', {}).get('playbook', {}) if candidate else {}
        vars_list = playbook_cfg.get('variables') or []
        if isinstance(playbook_cfg.get('template'), str):
            template = playbook_cfg.get('template')
        elif isinstance(workflow_config.get('description'), str):
            template = workflow_config.get('description')
        for v in vars_list:
            key = v.get('key')
            if isinstance(key, str) and key:
                variables.append(key)
    except Exception:
        variables = []

    tools_list = ', '.join(available_tools) if available_tools else 'Use any available tools from your system prompt'
    input_json = json.dumps(input_data or {}, indent=2)
    playbook_json = json.dumps({
        "name": workflow_config.get('name', 'Untitled Playbook'),
        "template": template,
        "variables": variables,
        "input_data": input_data or {}
    }, indent=2)

    return f"""You are executing a playbook. Treat the playbook template as authoritative high-level instructions.

PLAYBOOK:
{playbook_json}

EXECUTION RULES:
1) Substitute variables: wherever the template contains {{variable}}, use the matching value from input_data (keys: {', '.join(variables) if variables else 'none'}).
2) Do not output the template; instead, act on it: plan minimally and execute using available tools.
3) Use tools when needed. If a specific tool is required by the task (e.g., spreadsheets, web search), choose the best available tool.
4) Provide concise progress updates. If a tool is not available, state what you'd do as a fallback.

AVAILABLE TOOLS:
{tools_list}

WORKFLOW INPUT DATA:
{input_json}

Begin execution now, following the playbook template pragmatically."""



def get_next_run_time(cron_expression: str, user_timezone: str) -> Optional[datetime]:
    try:
        tz = pytz.timezone(user_timezone)
        now_local = datetime.now(tz)
        
        cron = croniter.croniter(cron_expression, now_local)
        
        next_run_local = cron.get_next(datetime)
        next_run_utc = next_run_local.astimezone(timezone.utc)
        
        return next_run_utc
        
    except Exception as e:
        logger.error(f"Error calculating next run time: {e}")
        return None


def get_human_readable_schedule(cron_expression: str, user_timezone: str) -> str:
    try:
        patterns = {
            '*/5 * * * *': 'Every 5 minutes',
            '*/10 * * * *': 'Every 10 minutes',
            '*/15 * * * *': 'Every 15 minutes',
            '*/30 * * * *': 'Every 30 minutes',
            '0 * * * *': 'Every hour',
            '0 */2 * * *': 'Every 2 hours',
            '0 */4 * * *': 'Every 4 hours',
            '0 */6 * * *': 'Every 6 hours',
            '0 */12 * * *': 'Every 12 hours',
            '0 0 * * *': 'Daily at midnight',
            '0 9 * * *': 'Daily at 9:00 AM',
            '0 12 * * *': 'Daily at 12:00 PM',
            '0 18 * * *': 'Daily at 6:00 PM',
            '0 9 * * 1-5': 'Weekdays at 9:00 AM',
            '0 9 * * 1': 'Every Monday at 9:00 AM',
            '0 9 * * 2': 'Every Tuesday at 9:00 AM',
            '0 9 * * 3': 'Every Wednesday at 9:00 AM',
            '0 9 * * 4': 'Every Thursday at 9:00 AM',
            '0 9 * * 5': 'Every Friday at 9:00 AM',
            '0 9 * * 6': 'Every Saturday at 9:00 AM',
            '0 9 * * 0': 'Every Sunday at 9:00 AM',
            '0 9 1 * *': 'Monthly on the 1st at 9:00 AM',
            '0 9 15 * *': 'Monthly on the 15th at 9:00 AM',
            '0 9,17 * * *': 'Daily at 9:00 AM and 5:00 PM',
            '0 10 * * 0,6': 'Weekends at 10:00 AM',
        }
        
        if cron_expression in patterns:
            description = patterns[cron_expression]
            if user_timezone != 'UTC':
                description += f" ({user_timezone})"
            return description
        
        parts = cron_expression.split()
        if len(parts) != 5:
            return f"Custom schedule: {cron_expression}"
            
        minute, hour, day, month, weekday = parts

        if minute.isdigit() and hour == '*' and day == '*' and month == '*' and weekday == '*':
            return f"Every hour at :{minute.zfill(2)}"
            
        if minute.isdigit() and hour.isdigit() and day == '*' and month == '*' and weekday == '*':
            time_str = f"{hour.zfill(2)}:{minute.zfill(2)}"
            description = f"Daily at {time_str}"
            if user_timezone != 'UTC':
                description += f" ({user_timezone})"
            return description
            
        if minute.isdigit() and hour.isdigit() and day == '*' and month == '*' and weekday == '1-5':
            time_str = f"{hour.zfill(2)}:{minute.zfill(2)}"
            description = f"Weekdays at {time_str}"
            if user_timezone != 'UTC':
                description += f" ({user_timezone})"
            return description
            
        return f"Custom schedule: {cron_expression}"
        
    except Exception:
        return f"Custom schedule: {cron_expression}"
