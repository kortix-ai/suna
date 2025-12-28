-- Vercel Analytics: Simple unique visitor tracking via drains
-- One row per day, array of device_ids

CREATE TABLE IF NOT EXISTS vercel_analytics_daily (
  date DATE PRIMARY KEY,
  device_ids TEXT[] DEFAULT '{}'
);

-- Function to get analytics for a single date
CREATE OR REPLACE FUNCTION get_vercel_analytics(target_date DATE)
RETURNS TABLE(pageviews BIGINT, unique_visitors BIGINT) AS $$
DECLARE
  visitor_count BIGINT;
BEGIN
  SELECT COALESCE(array_length(device_ids, 1), 0)
  INTO visitor_count
  FROM vercel_analytics_daily
  WHERE date = target_date;
  
  -- Return same value for both (we only track unique visitors)
  RETURN QUERY SELECT COALESCE(visitor_count, 0), COALESCE(visitor_count, 0);
END;
$$ LANGUAGE plpgsql;

-- Function to get analytics for a date range
CREATE OR REPLACE FUNCTION get_vercel_analytics_range(start_date DATE, end_date DATE)
RETURNS TABLE(analytics_date DATE, pageviews BIGINT, unique_visitors BIGINT) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    v.date as analytics_date,
    COALESCE(array_length(v.device_ids, 1), 0)::BIGINT as pageviews,
    COALESCE(array_length(v.device_ids, 1), 0)::BIGINT as unique_visitors
  FROM vercel_analytics_daily v
  WHERE v.date >= start_date AND v.date <= end_date
  ORDER BY v.date;
END;
$$ LANGUAGE plpgsql;

-- Upsert function: add device_id to array if not already present
CREATE OR REPLACE FUNCTION upsert_vercel_pageview(p_date DATE, p_device_id TEXT)
RETURNS VOID AS $$
BEGIN
  INSERT INTO vercel_analytics_daily (date, device_ids)
  VALUES (p_date, ARRAY[p_device_id])
  ON CONFLICT (date) DO UPDATE 
  SET device_ids = CASE 
    WHEN p_device_id = ANY(vercel_analytics_daily.device_ids) THEN vercel_analytics_daily.device_ids
    ELSE array_append(vercel_analytics_daily.device_ids, p_device_id)
  END;
END;
$$ LANGUAGE plpgsql;
