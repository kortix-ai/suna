"""
Use Case Clustering Service

Groups use cases by category - the LLM already categorizes during analysis,
so we just need a simple GROUP BY query.
"""

from typing import List, Dict, Any, Optional

from core.services.supabase import DBConnection
from core.utils.logger import logger


async def get_clustered_use_cases(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    distance_threshold: float = 0.3,  # Kept for API compatibility, not used
    min_cluster_size: int = 2
) -> List[Dict[str, Any]]:
    """
    Get use cases grouped by category.

    The LLM already assigns use_case_category during analysis,
    so we just GROUP BY that field and count unique threads.
    """
    try:
        db = DBConnection()
        client = await db.client

        # Simple query - group by category, count unique threads
        query = client.from_('conversation_analytics')\
            .select('use_case_category, thread_id, account_id')\
            .not_.is_('use_case_category', 'null')

        if date_from:
            query = query.gte('analyzed_at', f"{date_from}T00:00:00Z")
        if date_to:
            query = query.lte('analyzed_at', f"{date_to}T23:59:59Z")

        result = await query.execute()
        records = result.data or []

        # Group by category
        from collections import defaultdict
        groups = defaultdict(lambda: {'threads': set(), 'examples': []})

        for r in records:
            cat = r.get('use_case_category')
            if cat:
                groups[cat]['threads'].add(r.get('thread_id'))
                if len(groups[cat]['examples']) < 5:
                    groups[cat]['examples'].append({
                        'thread_id': r.get('thread_id'),
                        'account_id': r.get('account_id')
                    })

        # Build result
        clusters = []
        for cat, data in groups.items():
            count = len(data['threads'])
            if count >= min_cluster_size:
                clusters.append({
                    'cluster_id': hash(cat) % 10000,
                    'label': cat,
                    'count': count,
                    'examples': data['examples']
                })

        clusters.sort(key=lambda x: x['count'], reverse=True)

        logger.info(f"[CLUSTERING] Found {len(clusters)} categories from {len(records)} records")
        return clusters

    except Exception as e:
        logger.error(f"[CLUSTERING] Failed to get use case clusters: {e}", exc_info=True)
        raise
