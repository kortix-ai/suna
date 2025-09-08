"""
Query utilities for handling large datasets and avoiding URI length limits.
"""
from typing import List, Any, Dict, Optional
from core.utils.logger import logger


async def batch_query_in(
    client,
    table_name: str,
    select_fields: str,
    in_field: str,
    in_values: List[Any],
    batch_size: int = 100,
    additional_filters: Optional[Dict[str, Any]] = None,
    schema: Optional[str] = None
) -> List[Dict[str, Any]]:
    """
    Execute a query with .in_() filtering, automatically batching large arrays to avoid URI limits.
    
    Args:
        client: Supabase client
        table_name: Name of the table to query
        select_fields: Fields to select (e.g., '*' or 'id, name, created_at')
        in_field: Field name for the .in_() filter
        in_values: List of values to filter by
        batch_size: Maximum number of values per batch (default: 100)
        additional_filters: Optional dict of additional filters to apply
        schema: Optional schema name (for basejump tables)
    
    Returns:
        List of all matching records from all batches
    """
    if not in_values:
        return []
    
    all_results = []
    
    # If values list is small, do a single query
    if len(in_values) <= batch_size:
        query = client.schema(schema).from_(table_name) if schema else client.table(table_name)
        query = query.select(select_fields).in_(in_field, in_values)
        
        # Apply additional filters
        if additional_filters:
            for field, value in additional_filters.items():
                if field.endswith('_gte'):
                    query = query.gte(field[:-4], value)
                elif field.endswith('_eq'):
                    query = query.eq(field[:-3], value)
                else:
                    query = query.eq(field, value)
        
        result = await query.execute()
        return result.data or []
    
    # Batch processing for large arrays
    logger.debug(f"Batching {len(in_values)} {in_field} values into chunks of {batch_size}")
    
    for i in range(0, len(in_values), batch_size):
        batch_values = in_values[i:i + batch_size]
        
        query = client.schema(schema).from_(table_name) if schema else client.table(table_name)
        query = query.select(select_fields).in_(in_field, batch_values)
        
        # Apply additional filters
        if additional_filters:
            for field, value in additional_filters.items():
                if field.endswith('_gte'):
                    query = query.gte(field[:-4], value)
                elif field.endswith('_eq'):
                    query = query.eq(field[:-3], value)
                else:
                    query = query.eq(field, value)
        
        batch_result = await query.execute()
        if batch_result.data:
            all_results.extend(batch_result.data)
    
    logger.debug(f"Batched query returned {len(all_results)} total results")
    return all_results
