-- Allow the server-side medical-file Edge Function to use the protected
-- application gateway with the Supabase service role.
--
-- The browser continues to use the anon grant and never receives the
-- service-role credential. The gateway remains SECURITY DEFINER and performs
-- its own opaque-session and same-doctor confirmation checks.

grant execute
  on function public.msob_gateway(text, text, jsonb)
  to service_role;

-- The Edge Function stores private-file metadata itself. Keep this narrower
-- than broad CRUD: it only needs to read, insert, and delete folder entries.
grant select, insert, delete
  on table public.dossier_medical_document
  to service_role;

-- Used only to roll back a newly created patient if a later private-file step
-- fails. Normal patient creation and editing still go through msob_gateway.
grant delete
  on table public.dossier_medical_patient
  to service_role;
