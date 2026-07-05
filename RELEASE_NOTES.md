Turn auto-resume for transient provider errors

Agent sessions now automatically resume a turn killed by a transient provider failure (e.g. a model host stall ending in "Upstream idle timeout exceeded", connection resets, 5xx after retries) instead of surfacing a dead error turn. Root sessions only, max 3 resumes per 15 minutes with backoff, never for user aborts or auth/credit errors, kill switch KORTIX_TURN_AUTO_RESUME=0. Completes the v0.9.94 GLM routing fix.
