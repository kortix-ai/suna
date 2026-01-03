from typing import List, Dict, Any, Optional, TypeVar, Generic, Callable, Awaitable
from pydantic import BaseModel
from dataclasses import dataclass
from core.utils.logger import logger
import math

T = TypeVar('T')

class PaginationMeta(BaseModel):
    current_page: int
    page_size: int
    total_items: int
    total_pages: int
    has_next: bool
    has_previous: bool
    next_cursor: Optional[str] = None
    previous_cursor: Optional[str] = None

class PaginatedResponse(BaseModel, Generic[T]):
    data: List[T]
    pagination: PaginationMeta

@dataclass
class PaginationParams:
    page: int = 1
    page_size: int = 20
    cursor: Optional[str] = None
    
    def __post_init__(self):
        self.page = max(1, self.page)
        self.page_size = min(max(1, self.page_size), 100)

class PaginationService:
    @staticmethod
    async def paginate_with_total_count(
        items: List[T],
        total_count: int,
        params: PaginationParams
    ) -> PaginatedResponse[T]:
        """
        Create paginated response when you already have the items and total count.
        Use this when you've already applied all filtering and have the final dataset.
        """
        total_pages = max(1, math.ceil(total_count / params.page_size))
        
        pagination_meta = PaginationMeta(
            current_page=params.page,
            page_size=params.page_size,
            total_items=total_count,
            total_pages=total_pages,
            has_next=params.page < total_pages,
            has_previous=params.page > 1
        )
        
        return PaginatedResponse(
            data=items,
            pagination=pagination_meta
        )
    
    @staticmethod
    async def paginate_database_query(
        base_query: Any,
        params: PaginationParams,
        post_process_filter: Optional[Callable[[List[Dict[str, Any]]], List[Dict[str, Any]]]] = None
    ) -> PaginatedResponse[Dict[str, Any]]:
        """
        Paginate a Supabase query.
        
        IMPORTANT: The base_query MUST be created with count='exact' in the .select() call.
        Example: db.table('items').select('*', count='exact').eq('active', True)
        
        The count will be extracted from the result.count field which contains
        the total matching rows (ignoring any range applied).
        """
        try:
            # Calculate offset for pagination
            offset = (params.page - 1) * params.page_size
            
            # Execute query with range - Supabase returns count for full query (ignoring range)
            # when count='exact' was specified in the original .select() call
            data_result = await base_query.range(offset, offset + params.page_size - 1).execute()
            
            items = data_result.data or []
            # Get total count from result (requires count='exact' in original select)
            # If count is None, it means count='exact' wasn't used - fallback to len(items)
            total_count = getattr(data_result, 'count', None)
            if total_count is None:
                logger.warning("Pagination: count='exact' not found in query result, using len(items) as fallback")
                total_count = len(items)
            
            logger.debug(f"Pagination query result: {len(items)} items, total_count: {total_count}")
            
            if post_process_filter:
                items = post_process_filter(items)
            
            if total_count == 0:
                return PaginatedResponse(
                    data=[],
                    pagination=PaginationMeta(
                        current_page=params.page,
                        page_size=params.page_size,
                        total_items=0,
                        total_pages=0,
                        has_next=False,
                        has_previous=False
                    )
                )
                
            total_pages = max(1, math.ceil(total_count / params.page_size))
            
            pagination_meta = PaginationMeta(
                current_page=params.page,
                page_size=params.page_size,
                total_items=total_count,
                total_pages=total_pages,
                has_next=params.page < total_pages,
                has_previous=params.page > 1
            )
            
            return PaginatedResponse(
                data=items,
                pagination=pagination_meta
            )
            
        except Exception as e:
            logger.error(f"Pagination error: {e}", exc_info=True)
            raise

    @staticmethod
    async def paginate_filtered_dataset(
        all_items: List[T],
        params: PaginationParams,
        filter_func: Optional[Callable[[T], bool]] = None
    ) -> PaginatedResponse[T]:
        if filter_func:
            filtered_items = [item for item in all_items if filter_func(item)]
        else:
            filtered_items = all_items
        
        total_count = len(filtered_items)
        
        if total_count == 0:
            return PaginatedResponse(
                data=[],
                pagination=PaginationMeta(
                    current_page=params.page,
                    page_size=params.page_size,
                    total_items=0,
                    total_pages=0,
                    has_next=False,
                    has_previous=False
                )
            )
        
        start_index = (params.page - 1) * params.page_size
        end_index = start_index + params.page_size
        page_items = filtered_items[start_index:end_index]
        
        total_pages = max(1, math.ceil(total_count / params.page_size))
        
        pagination_meta = PaginationMeta(
            current_page=params.page,
            page_size=params.page_size,
            total_items=total_count,
            total_pages=total_pages,
            has_next=params.page < total_pages,
            has_previous=params.page > 1
        )
        
        return PaginatedResponse(
            data=page_items,
            pagination=pagination_meta
        )

    @staticmethod
    def create_cursor(item_id: str, sort_field: str, sort_value: Any) -> str:
        import base64
        import json
        
        cursor_data = {
            "id": item_id,
            "sort_field": sort_field,
            "sort_value": str(sort_value)
        }
        cursor_json = json.dumps(cursor_data, sort_keys=True)
        return base64.b64encode(cursor_json.encode()).decode()
    
    @staticmethod
    def parse_cursor(cursor: str) -> Optional[Dict[str, Any]]:
        try:
            import base64
            import json
            
            cursor_json = base64.b64decode(cursor).decode()
            return json.loads(cursor_json)
        except Exception as e:
            logger.warning(f"Failed to parse cursor: {e}")
            return None 