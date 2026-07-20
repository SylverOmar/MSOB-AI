begin;

create or replace function private.write_activity_log(
  p_actor_type text,
  p_actor_id uuid,
  p_actor_access_id text,
  p_actor_prenom text,
  p_actor_nom text,
  p_action text,
  p_target_type text,
  p_target_id text default null,
  p_target_label text default null,
  p_details jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_log_id uuid;
  v_action text := lower(pg_catalog.btrim(coalesce(p_action, '')));
  v_target_type text := lower(pg_catalog.btrim(coalesce(p_target_type, '')));
  v_details jsonb := coalesce(p_details, '{}'::jsonb);
begin
  if p_actor_type not in ('doctor', 'admin') then
    raise exception 'Rôle journal invalide';
  end if;
  if v_action not in (
    'patient.created',
    'patient.updated',
    'patient.deleted',
    'medical_folder.added',
    'medical_folder.updated',
    'report.confirmed',
    'analysis.launched',
    'analysis.retried',
    'doctor.created',
    'doctor.updated',
    'doctor.deleted'
  ) then
    raise exception 'Action journal invalide';
  end if;
  if v_target_type not in ('patient', 'doctor', 'medical_folder', 'report', 'analysis') then
    raise exception 'Cible journal invalide';
  end if;
  if pg_catalog.jsonb_typeof(v_details) <> 'object' then
    raise exception 'Détails journal invalides';
  end if;

  insert into private.activity_log (
    actor_type,
    actor_id,
    actor_access_id,
    actor_prenom,
    actor_nom,
    action,
    target_type,
    target_id,
    target_label_encrypted,
    details
  )
  values (
    p_actor_type,
    p_actor_id,
    pg_catalog.lower(pg_catalog.btrim(p_actor_access_id)),
    pg_catalog.initcap(pg_catalog.lower(pg_catalog.btrim(p_actor_prenom))),
    pg_catalog.upper(pg_catalog.btrim(p_actor_nom)),
    v_action,
    v_target_type,
    nullif(pg_catalog.btrim(p_target_id), ''),
    case
      when nullif(pg_catalog.btrim(p_target_label), '') is null then null
      else pg_catalog.encode(
        extensions.pgp_sym_encrypt(
          pg_catalog.btrim(p_target_label),
          private.pii_key(),
          'cipher-algo=aes256,compress-algo=0'
        ),
        'base64'
      )
    end,
    v_details
  )
  returning id into v_log_id;

  return v_log_id;
end;
$function$;

revoke all on function private.write_activity_log(
  text, uuid, text, text, text, text, text, text, text, jsonb
) from public, anon, authenticated, service_role;

create or replace function public.msob_record_activity(
  p_token text,
  p_action text,
  p_target_type text,
  p_target_id text default null,
  p_target_label text default null,
  p_details jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_type text;
  v_actor_id uuid;
  v_actor_access_id text;
  v_actor_prenom text;
  v_actor_nom text;
begin
  delete from private.app_session where expires_at <= pg_catalog.now();

  select actor_type, actor_id
  into v_actor_type, v_actor_id
  from private.app_session
  where token_hash = pg_catalog.encode(extensions.digest(p_token, 'sha256'), 'hex')
    and expires_at > pg_catalog.now();

  if not found then
    raise exception 'Session expirée ou invalide';
  end if;

  if v_actor_type = 'doctor' then
    select doctor_id, prenom, nom
    into v_actor_access_id, v_actor_prenom, v_actor_nom
    from public.docteur
    where id = v_actor_id;
  else
    select admin_id, prenom, nom
    into v_actor_access_id, v_actor_prenom, v_actor_nom
    from public.administrateur
    where id = v_actor_id;
  end if;

  if not found then
    raise exception 'Utilisateur du journal introuvable';
  end if;

  return private.write_activity_log(
    v_actor_type,
    v_actor_id,
    v_actor_access_id,
    v_actor_prenom,
    v_actor_nom,
    p_action,
    p_target_type,
    p_target_id,
    p_target_label,
    p_details
  );
end;
$function$;

revoke all on function public.msob_record_activity(
  text, text, text, text, text, jsonb
) from public, anon, authenticated;

grant execute on function public.msob_record_activity(
  text, text, text, text, text, jsonb
) to service_role;

create or replace function public.msob_list_activity(
  p_token text,
  p_limit integer default 250
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid;
  v_limit integer := least(greatest(coalesce(p_limit, 250), 1), 500);
  v_logs jsonb;
begin
  delete from private.app_session where expires_at <= pg_catalog.now();

  select actor_id
  into v_actor_id
  from private.app_session
  where token_hash = pg_catalog.encode(extensions.digest(p_token, 'sha256'), 'hex')
    and actor_type = 'admin'
    and expires_at > pg_catalog.now();

  if not found then
    raise exception 'Session administrateur expirée ou invalide';
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) order by x.created_at desc),
    '[]'::jsonb
  )
  into v_logs
  from (
    select
      l.id,
      l.created_at,
      l.actor_type,
      l.actor_access_id,
      l.actor_prenom,
      l.actor_nom,
      l.action,
      l.target_type,
      l.target_id,
      case
        when l.target_label_encrypted is null then null
        else extensions.pgp_sym_decrypt(
          pg_catalog.decode(l.target_label_encrypted, 'base64'),
          private.pii_key()
        )
      end as target_label,
      l.details
    from private.activity_log l
    order by l.created_at desc
    limit v_limit
  ) x;

  return pg_catalog.jsonb_build_object('logs', v_logs);
end;
$function$;

revoke all on function public.msob_list_activity(text, integer)
  from public, anon, authenticated;

grant execute on function public.msob_list_activity(text, integer)
  to service_role;

create or replace function public.msob_admin_create_patient(
  p_token text,
  p_confirm_admin_id text,
  p_patient jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid;
  v_admin record;
  v_patient_id uuid;
  v_confirm_id text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_confirm_admin_id, '')));
begin
  delete from private.app_session where expires_at <= pg_catalog.now();

  select actor_id
  into v_actor_id
  from private.app_session
  where token_hash = pg_catalog.encode(extensions.digest(p_token, 'sha256'), 'hex')
    and actor_type = 'admin'
    and expires_at > pg_catalog.now();

  if not found then
    raise exception 'Session administrateur expirée ou invalide';
  end if;

  select id, admin_id, prenom, nom
  into v_admin
  from public.administrateur
  where id = v_actor_id;

  if not found then
    raise exception 'Administrateur introuvable';
  end if;
  if v_confirm_id <> v_admin.admin_id then
    raise exception 'ID administrateur différent de la session ouverte';
  end if;
  if p_patient is null or pg_catalog.jsonb_typeof(p_patient) <> 'object' then
    raise exception 'Informations patient invalides';
  end if;

  v_patient_id := public.secure_create_patient(
    p_patient->>'cin',
    p_patient->>'prenom',
    p_patient->>'nom',
    (p_patient->>'age')::integer,
    (p_patient->>'genre')::character varying,
    (p_patient->>'handicap')::character varying
  );

  return pg_catalog.jsonb_build_object('ok', true, 'patient_id', v_patient_id);
end;
$function$;

revoke all on function public.msob_admin_create_patient(text, text, jsonb)
  from public, anon, authenticated;

grant execute on function public.msob_admin_create_patient(text, text, jsonb)
  to service_role;

commit;
