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
        count_query: Optional[Any] = None,
        post_process_filter: Optional[Callable[[List[Dict[str, Any]]], List[Dict[str, Any]]]] = None
    ) -> PaginatedResponse[Dict[str, Any]]:
        try:
            if count_query:
                count_result = await count_query.execute()
                total_count = count_result.count if count_result.count else 0
            else:
                count_result = await base_query.select('*', count='exact').execute()
                total_count = count_result.count if count_result.count else 0
            
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
            
            offset = (params.page - 1) * params.page_size
            data_query = base_query.range(offset, offset + params.page_size - 1)
            data_result = await data_query.execute()
            items = data_result.data or []
            
            if post_process_filter:
                items = post_process_filter(items)
                
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