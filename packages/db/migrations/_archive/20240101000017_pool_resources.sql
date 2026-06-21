-- Pool configuration: what machine types to keep warm
CREATE TABLE IF NOT EXISTS kortix.pool_resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider kortix.sandbox_provider NOT NULL,
  server_type VARCHAR(64) NOT NULL,
  location VARCHAR(64) NOT NULL,
  desired_count INTEGER NOT NULL DEFAULT 2,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pool_resources_unique
  ON kortix.pool_resources (provider, server_type, location);

-- Pool inventory: actual pre-provisioned machines waiting to be claimed
CREATE TABLE IF NOT EXISTS kortix.pool_sandboxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id UUID REFERENCES kortix.pool_resources(id) ON DELETE SET NULL,
  provider kortix.sandbox_provider NOT NULL,
  external_id TEXT NOT NULL,
  base_url TEXT NOT NULL DEFAULT '',
  server_type VARCHAR(64) NOT NULL,
  location VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'provisioning',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ready_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pool_sandboxes_claim
  ON kortix.pool_sandboxes (status, created_at) WHERE status = 'ready';
