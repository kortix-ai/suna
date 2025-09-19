from typing import List, Dict, Any, Optional
from core.utils.pagination import PaginationService, PaginationParams, PaginatedResponse, PaginationMeta
from core.utils.logger import logger
from core.utils.query_utils import batch_query_in


class MarketplaceFilters:
    def __init__(
        self,
        search: Optional[str] = None,
        tags: Optional[List[str]] = None,
        is_kortix_team: Optional[bool] = None,
        creator_id: Optional[str] = None,
        sort_by: str = "download_count",
        sort_order: str = "desc"
    ):
        self.search = search
        self.tags = tags or []
        self.is_kortix_team = is_kortix_team
        self.creator_id = creator_id
        self.sort_by = sort_by
        self.sort_order = sort_order


class TemplateService:
    def __init__(self, db_client):
        self.db = db_client

    async def get_marketplace_templates_paginated(
        self,
        pagination_params: PaginationParams,
        filters: MarketplaceFilters
    ) -> PaginatedResponse[Dict[str, Any]]:
        try:
            logger.debug(f"Fetching marketplace templates with filters: {filters.__dict__}")
            
            from ..template_service import get_template_service
            from ..utils import format_template_for_response
            from core.services.supabase import DBConnection
            
            db_connection = DBConnection()
            template_service = get_template_service(db_connection)
            
            limit = pagination_params.page_size
            offset = (pagination_params.page - 1) * pagination_params.page_size
            
            templates = await template_service.get_public_templates(
                is_kortix_team=filters.is_kortix_team,
                limit=limit,
                offset=offset,
                search=filters.search,
                tags=filters.tags
            )
            
            base_query = self._build_marketplace_base_query(filters)
            count_query = self._build_marketplace_count_query(filters)
            count_result = await count_query.execute()
            total_items = count_result.count if count_result.count is not None else 0
            
            if filters.creator_id is not None:
                templates = [t for t in templates if t.creator_id == filters.creator_id]
                if filters.creator_id:
                    all_templates = await template_service.get_public_templates(
                        is_kortix_team=filters.is_kortix_team,
                        search=filters.search,
                        tags=filters.tags
                    )
                    filtered_templates = [t for t in all_templates if t.creator_id == filters.creator_id]
                    total_items = len(filtered_templates)
            
            template_responses = []
            for template in templates:
                template_response = format_template_for_response(template)
                template_responses.append(template_response)
            
            total_pages = (total_items + pagination_params.page_size - 1) // pagination_params.page_size
            has_next = pagination_params.page < total_pages
            has_previous = pagination_params.page > 1
            
            return PaginatedResponse(
                data=template_responses,
                pagination=PaginationMeta(
                    current_page=pagination_params.page,
                    page_size=pagination_params.page_size,
                    total_items=total_items,
                    total_pages=total_pages,
                    has_next=has_next,
                    has_previous=has_previous
                )
            )
                
        except Exception as e:
            logger.error(f"Error fetching marketplace templates: {e}", exc_info=True)
            raise

    async def get_user_templates_paginated(
        self,
        pagination_params: PaginationParams,
        filters: MarketplaceFilters
    ) -> PaginatedResponse[Dict[str, Any]]:
        try:
            logger.debug(f"Fetching user templates with filters: {filters.__dict__}")
            
            from ..template_service import get_template_service
            from ..utils import format_template_for_response
            from core.services.supabase import DBConnection
            
            if not filters.creator_id:
                raise ValueError("creator_id is required for user templates")
            
            db_connection = DBConnection()
            template_service = get_template_service(db_connection)
            
            all_templates = await template_service.get_user_templates(filters.creator_id)

            filtered_templates = all_templates
            if filters.search:
                search_term = filters.search.lower()
                filtered_templates = [
                    t for t in filtered_templates 
                    if (search_term in t.name.lower() if t.name else False) or 
                       (search_term in t.description.lower() if t.description else False)
                ]
            
            if filters.tags:
                tag_set = set(filters.tags)
                filtered_templates = [
                    t for t in filtered_templates 
                    if tag_set.intersection(set(t.tags or []))
                ]
            
            if filters.sort_by == "name":
                filtered_templates.sort(key=lambda t: t.name.lower() if t.name else '', 
                                      reverse=(filters.sort_order == "desc"))
            elif filters.sort_by == "download_count":
                filtered_templates.sort(key=lambda t: t.download_count, 
                                      reverse=(filters.sort_order == "desc"))
            else:
                filtered_templates.sort(key=lambda t: t.created_at, 
                                      reverse=(filters.sort_order == "desc"))
            
            total_items = len(filtered_templates)
            offset = (pagination_params.page - 1) * pagination_params.page_size
            limit = pagination_params.page_size
            paginated_templates = filtered_templates[offset:offset + limit]
            
            template_responses = []
            for template in paginated_templates:
                template_response = format_template_for_response(template)
                template_responses.append(template_response)
            
            total_pages = (total_items + pagination_params.page_size - 1) // pagination_params.page_size
            has_next = pagination_params.page < total_pages
            has_previous = pagination_params.page > 1
            
            return PaginatedResponse(
                data=template_responses,
                pagination=PaginationMeta(
                    current_page=pagination_params.page,
                    page_size=pagination_params.page_size,
                    total_items=total_items,
                    total_pages=total_pages,
                    has_next=has_next,
                    has_previous=has_previous
                )
            )
                
        except Exception as e:
            logger.error(f"Error fetching user templates: {e}", exc_info=True)
            raise

    def _build_marketplace_base_query(self, filters: MarketplaceFilters):
        query = self.db.table('agent_templates').select('*').eq('is_public', True)
        
        if filters.search:
            search_term = f"%{filters.search}%"
            query = query.or_(f"name.ilike.{search_term},description.ilike.{search_term}")
        
        if filters.is_kortix_team is not None:
            query = query.eq('is_kortix_team', filters.is_kortix_team)
            
        if filters.creator_id is not None:
            query = query.eq('creator_id', filters.creator_id)
        
        if filters.tags:
            for tag in filters.tags:
                query = query.contains('tags', [tag])
        
        if filters.sort_by == "download_count":
            query = query.order('download_count', desc=(filters.sort_order == "desc"))
            query = query.order('marketplace_published_at', desc=True)
        elif filters.sort_by == "newest":
            query = query.order('marketplace_published_at', desc=True)
        elif filters.sort_by == "name":
            query = query.order('name', desc=(filters.sort_order == "desc"))
        else:
            query = query.order('download_count', desc=True)
            query = query.order('marketplace_published_at', desc=True)
        
        return query

    def _build_marketplace_count_query(self, filters: MarketplaceFilters):
        query = self.db.table('agent_templates').select('*', count='exact').eq('is_public', True)
        
        if filters.search:
            search_term = f"%{filters.search}%"
            query = query.or_(f"name.ilike.{search_term},description.ilike.{search_term}")
        
        if filters.is_kortix_team is not None:
            query = query.eq('is_kortix_team', filters.is_kortix_team)
            
        if filters.creator_id is not None:
            query = query.eq('creator_id', filters.creator_id)
            
        if filters.tags:
            for tag in filters.tags:
                query = query.contains('tags', [tag])
                
        return query

    def _build_user_templates_base_query(self, filters: MarketplaceFilters):
        query = self.db.table('agent_templates').select('*')
        
        if filters.creator_id is not None:
            query = query.eq('creator_id', filters.creator_id)
        else:
            raise ValueError("creator_id filter is required for user templates")
        
        if filters.search:
            search_term = f"%{filters.search}%"
            query = query.or_(f"name.ilike.{search_term},description.ilike.{search_term}")
        
        if filters.tags:
            for tag in filters.tags:
                query = query.contains('tags', [tag])
        
        if filters.sort_by == "download_count":
            query = query.order('download_count', desc=(filters.sort_order == "desc"))
            query = query.order('created_at', desc=True)
        elif filters.sort_by == "name":
            query = query.order('name', desc=(filters.sort_order == "desc"))
        elif filters.sort_by == "created_at":
            query = query.order('created_at', desc=(filters.sort_order == "desc"))
        else:
            query = query.order('created_at', desc=True)
        
        return query

    def _build_user_templates_count_query(self, filters: MarketplaceFilters):
        query = self.db.table('agent_templates').select('*', count='exact')
        
        if filters.creator_id is not None:
            query = query.eq('creator_id', filters.creator_id)
        else:
            raise ValueError("creator_id filter is required for user templates")
        
        if filters.search:
            search_term = f"%{filters.search}%"
            query = query.or_(f"name.ilike.{search_term},description.ilike.{search_term}")
            
        if filters.tags:
            for tag in filters.tags:
                query = query.contains('tags', [tag])
                
        return query

 