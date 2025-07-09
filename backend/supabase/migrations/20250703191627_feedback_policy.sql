create policy "Authenticated read feedback"
on "public"."feedback"
as permissive
for select
to authenticated
using (true);



