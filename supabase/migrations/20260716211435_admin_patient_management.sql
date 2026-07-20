begin;

create or replace function public.msob_admin_patient_gateway(
  p_action text,
  p_token text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, extensions, pg_catalog
as $function$
declare
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_actor_id uuid;
  v_active_admin_id text;
  v_confirm_admin_id text;
  v_patient jsonb;
  v_patient_record record;
  v_patient_id uuid;
  v_expected_full_name text;
  v_submitted_full_name text;
  v_patients jsonb;
  v_reports jsonb;
  v_documents jsonb;
  v_storage_paths jsonb;
begin
  delete from private.app_session
  where expires_at <= now();

  if p_token is null or p_token = '' then
    raise exception 'Session requise';
  end if;

  select actor_id
  into v_actor_id
  from private.app_session
  where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    and actor_type = 'admin'
    and expires_at > now();

  if not found then
    raise exception 'Session administrateur expirée ou invalide';
  end if;

  if v_action = 'data' then
    select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
    into v_patients
    from public.secure_patient_list() x;

    select coalesce(
      jsonb_agg(to_jsonb(r) order by r.date_generation desc),
      '[]'::jsonb
    )
    into v_reports
    from public.rapport r;

    select coalesce(
      jsonb_agg(to_jsonb(d) order by d.date_ajout desc),
      '[]'::jsonb
    )
    into v_documents
    from public.dossier_medical_document d;

    return jsonb_build_object(
      'patients', v_patients,
      'reports', v_reports,
      'documents', v_documents
    );
  end if;

  select admin_id
  into v_active_admin_id
  from public.administrateur
  where id = v_actor_id;

  if not found then
    raise exception 'Administrateur introuvable';
  end if;

  v_confirm_admin_id := lower(btrim(coalesce(p_payload->>'confirmAdminId', '')));
  if v_confirm_admin_id <> v_active_admin_id then
    raise exception 'ID administrateur différent de la session ouverte';
  end if;

  if v_action = 'update-patient' then
    v_patient := p_payload->'patient';
    if v_patient is null or jsonb_typeof(v_patient) <> 'object' then
      raise exception 'Informations patient invalides';
    end if;

    perform public.secure_update_patient(
      (v_patient->>'id')::uuid,
      v_patient->>'cin',
      v_patient->>'prenom',
      v_patient->>'nom',
      (v_patient->>'age')::integer,
      v_patient->>'genre',
      v_patient->>'handicap'
    );

    return jsonb_build_object(
      'ok', true,
      'patient_id', (v_patient->>'id')::uuid
    );
  end if;

  if v_action = 'delete-patient' then
    v_patient_id := (p_payload->>'patientId')::uuid;

    select *
    into v_patient_record
    from public.secure_patient_list()
    where id = v_patient_id;

    if not found then
      raise exception 'Patient introuvable';
    end if;

    v_expected_full_name := v_patient_record.prenom || ' ' || v_patient_record.nom;
    v_submitted_full_name := btrim(coalesce(p_payload->>'patientFullName', ''));
    if v_submitted_full_name <> v_expected_full_name then
      raise exception 'Nom complet du patient incorrect';
    end if;

    select coalesce(
      jsonb_agg(d.chemin_stockage) filter (where d.chemin_stockage is not null),
      '[]'::jsonb
    )
    into v_storage_paths
    from public.dossier_medical_document d
    where d.dossier_id = v_patient_id;

    delete from public.dossier_medical_patient
    where id = v_patient_id;

    if not found then
      raise exception 'Patient introuvable';
    end if;

    return jsonb_build_object(
      'ok', true,
      'patient_id', v_patient_id,
      'storage_paths', v_storage_paths
    );
  end if;

  raise exception 'Action administrateur inconnue';
end;
$function$;

revoke all
  on function public.msob_admin_patient_gateway(text, text, jsonb)
  from public, anon, authenticated;

grant execute
  on function public.msob_admin_patient_gateway(text, text, jsonb)
  to service_role;

comment on function public.msob_admin_patient_gateway(text, text, jsonb) is
  'Server-only admin patient data, same-admin update, and complete patient deletion boundary.';

commit;
