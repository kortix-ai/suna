import datetime
from typing import Dict, Any


def render_prompt_template(prompt: str, **kwargs) -> str:
    """
    Render a prompt template by replacing template variables with actual values.
    
    This function processes template variables in the format {{variable_name}} and
    replaces them with corresponding values. It automatically includes current
    date/time variables and supports additional custom variables.
    
    Args:
        prompt: The prompt string containing template variables
        **kwargs: Additional custom variables to replace in the template
        
    Returns:
        The processed prompt with all template variables replaced
    """
    if not prompt or not isinstance(prompt, str):
        return prompt
    
    # Get current UTC time for date/time variables
    now_utc = datetime.datetime.now(datetime.timezone.utc)
    
    # Build template variables dictionary
    template_vars = {
        'current_date': now_utc.strftime('%Y-%m-%d'),
        'current_time': now_utc.strftime('%H:%M:%S'),
        'current_year': now_utc.strftime('%Y'),
        **kwargs  # Allow additional custom variables
    }
    
    # Replace template variables
    result = prompt
    for var_name, value in template_vars.items():
        result = result.replace('{{' + var_name + '}}', str(value))
    
    return result


def get_available_template_vars() -> Dict[str, str]:
    """
    Get a dictionary of all available built-in template variables and their descriptions.
    
    Returns:
        Dictionary mapping variable names to their descriptions
    """
    return {
        'current_date': 'Current UTC date in YYYY-MM-DD format',
        'current_time': 'Current UTC time in HH:MM:SS format', 
        'current_year': 'Current year as a 4-digit string'
    }
