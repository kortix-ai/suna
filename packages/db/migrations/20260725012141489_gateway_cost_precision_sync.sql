SET lock_timeout = '5s';
SET statement_timeout = '30min';

UPDATE kortix.gateway_request_logs
SET upstream_cost_precise = upstream_cost,
    final_cost_precise = final_cost;

UPDATE kortix.usage_events
SET cost_usd_precise = cost_usd;

CREATE FUNCTION kortix.sync_gateway_request_log_cost_precision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.upstream_cost_precise = 0 AND NEW.upstream_cost <> 0 THEN
      NEW.upstream_cost_precise := NEW.upstream_cost;
    ELSE
      NEW.upstream_cost := ROUND(NEW.upstream_cost_precise, 6);
    END IF;

    IF NEW.final_cost_precise = 0 AND NEW.final_cost <> 0 THEN
      NEW.final_cost_precise := NEW.final_cost;
    ELSE
      NEW.final_cost := ROUND(NEW.final_cost_precise, 6);
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.upstream_cost_precise IS DISTINCT FROM OLD.upstream_cost_precise THEN
    NEW.upstream_cost := ROUND(NEW.upstream_cost_precise, 6);
  ELSIF NEW.upstream_cost IS DISTINCT FROM OLD.upstream_cost THEN
    NEW.upstream_cost_precise := NEW.upstream_cost;
  END IF;

  IF NEW.final_cost_precise IS DISTINCT FROM OLD.final_cost_precise THEN
    NEW.final_cost := ROUND(NEW.final_cost_precise, 6);
  ELSIF NEW.final_cost IS DISTINCT FROM OLD.final_cost THEN
    NEW.final_cost_precise := NEW.final_cost;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER sync_gateway_request_log_cost_precision
BEFORE INSERT OR UPDATE ON kortix.gateway_request_logs
FOR EACH ROW
EXECUTE FUNCTION kortix.sync_gateway_request_log_cost_precision();

CREATE FUNCTION kortix.sync_usage_event_cost_precision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.cost_usd_precise = 0 AND NEW.cost_usd <> 0 THEN
      NEW.cost_usd_precise := NEW.cost_usd;
    ELSE
      NEW.cost_usd := ROUND(NEW.cost_usd_precise, 6);
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.cost_usd_precise IS DISTINCT FROM OLD.cost_usd_precise THEN
    NEW.cost_usd := ROUND(NEW.cost_usd_precise, 6);
  ELSIF NEW.cost_usd IS DISTINCT FROM OLD.cost_usd THEN
    NEW.cost_usd_precise := NEW.cost_usd;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER sync_usage_event_cost_precision
BEFORE INSERT OR UPDATE ON kortix.usage_events
FOR EACH ROW
EXECUTE FUNCTION kortix.sync_usage_event_cost_precision();
