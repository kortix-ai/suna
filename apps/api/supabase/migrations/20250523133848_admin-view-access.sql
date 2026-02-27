DROP POLICY IF EXISTS "Give read only access to internal users" ON threads;

CREATE POLICY "Give read only access to internal users" ON threads
FOR SELECT
USING (
    ((auth.jwt() ->> 'email'::text) ~~ '%@kortix.ai'::text)
);


DROP POLICY IF EXISTS "Give read only access to internal users" ON messages;

CREATE POLICY "Give read only access to internal users" ON messages
FOR SELECT
USING (
    ((auth.jwt() ->> 'email'::text) ~~ '%@kortix.ai'::text)
);


DROP POLICY IF EXISTS "Give read only access to internal users" ON projects;

CREATE POLICY "Give read only access to internal users" ON projects
FOR SELECT
USING (
    ((auth.jwt() ->> 'email'::text) ~~ '%@kortix.ai'::text)
);
