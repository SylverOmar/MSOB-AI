-- MSOB AI medical-folder file storage.
-- Files are private and are accessible only through the validated Edge Function.

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'medical-folder',
  'medical-folder',
  false,
  26214400,
  null
)
on conflict (id) do update
set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create index if not exists dossier_medical_document_dossier_date_idx
  on public.dossier_medical_document (dossier_id, date_ajout desc);

create unique index if not exists dossier_medical_document_storage_path_uidx
  on public.dossier_medical_document (chemin_stockage)
  where chemin_stockage is not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'dossier_medical_document_dossier_id_fkey'
      and conrelid = 'public.dossier_medical_document'::regclass
  ) then
    alter table public.dossier_medical_document
      add constraint dossier_medical_document_dossier_id_fkey
      foreign key (dossier_id)
      references public.dossier_medical_patient(id)
      on delete cascade;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'rapport_dossier_id_fkey'
      and conrelid = 'public.rapport'::regclass
  ) then
    alter table public.rapport
      add constraint rapport_dossier_id_fkey
      foreign key (dossier_id)
      references public.dossier_medical_patient(id)
      on delete cascade;
  end if;
end
$$;

-- This duplicate index predates the migration and covers the same columns.
drop index if exists public.dossier_medical_document_dossier_id_idx;

comment on column public.dossier_medical_document.chemin_stockage is
  'Private Supabase Storage object path. Null for text-only medical-folder entries.';

comment on table public.dossier_medical_document is
  'Medical-folder text entries and private file metadata. Binary files live in the private medical-folder Storage bucket.';
