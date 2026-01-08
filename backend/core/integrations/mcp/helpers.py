"""Helper utilities for managing MCP (Model Context Protocol) configurations."""
from typing import List, Dict, Any


def merge_custom_mcps(existing_mcps: List[Dict[str, Any]], new_mcps: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Merge new custom MCP configurations with existing ones.
    
    If an MCP with the same name exists, it will be replaced with the new configuration.
    Otherwise, the new MCP is appended to the list.
    
    Args:
        existing_mcps: List of existing MCP configurations
        new_mcps: List of new MCP configurations to merge in
        
    Returns:
        Merged list of MCP configurations
    """
    if not new_mcps:
        return existing_mcps
    
    merged_mcps = existing_mcps.copy()
    
    for new_mcp in new_mcps:
        new_mcp_name = new_mcp.get('name')
        existing_index = None
        
        # Find if this MCP already exists
        for i, existing_mcp in enumerate(merged_mcps):
            if existing_mcp.get('name') == new_mcp_name:
                existing_index = i
                break
        
        # Replace or append
        if existing_index is not None:
            merged_mcps[existing_index] = new_mcp
        else:
            merged_mcps.append(new_mcp)
    
    return merged_mcps

