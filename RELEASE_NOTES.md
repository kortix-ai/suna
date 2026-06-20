Fix private repo provisioning failures

Fixes an intermittent production session provisioning failure for private GitHub repos. The shared per-project git mirror now resolves stored project credentials before clone/fetch even when a tokenless background caller wins the refresh lock, preventing unauthenticated cold-cache clones. Git repository authentication failures are also categorized as git-auth instead of being misreported as a Daytona provider failure.
