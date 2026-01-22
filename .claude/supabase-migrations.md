# Supabase Migrations

## Creating Migrations

Always use the Supabase CLI to create new migrations:

```bash
cd backend
supabase migration new <migration_name>
```

This generates a properly timestamped migration file in `backend/supabase/migrations/`.

**Never manually create migration files** - always use the CLI to ensure correct timestamps and naming.

## Migration Location

All migrations live in: `backend/supabase/migrations/`

## Applying Migrations

### Local Development
```bash
cd backend
supabase db reset  # Reset and apply all migrations
```

### Remote/Production
```bash
cd backend
supabase db push  # Push migrations to remote database
```

Or apply SQL directly in the Supabase Dashboard SQL Editor for urgent fixes.

## Storage Buckets

When modifying storage bucket settings (like `allowed_mime_types`), use an `UPDATE` statement since buckets are created in earlier migrations:

```sql
UPDATE storage.buckets
SET allowed_mime_types = ARRAY[...]::text[]
WHERE id = 'bucket-name';
```

## Current Buckets

- `staged-files` - User file uploads (documents, images, code, etc.)
- `agentpress` - Agent-related files
- `user-avatars` - User profile pictures
