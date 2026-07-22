begin;

alter table private.activity_log
  drop constraint if exists activity_log_action_check;

alter table private.activity_log
  add constraint activity_log_action_check check (
    action in (
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
      'doctor.deleted',
      'admin.created',
      'admin.updated',
      'admin.deleted',
      'settings.updated'
    )
  );

alter table private.activity_log
  drop constraint if exists activity_log_target_type_check;

alter table private.activity_log
  add constraint activity_log_target_type_check check (
    target_type in (
      'patient',
      'doctor',
      'medical_folder',
      'report',
      'analysis',
      'admin',
      'configuration'
    )
  );

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
  v_action text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_action, '')));
  v_target_type text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_target_type, '')));
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
    'doctor.deleted',
    'admin.created',
    'admin.updated',
    'admin.deleted',
    'settings.updated'
  ) then
    raise exception 'Action journal invalide';
  end if;
  if v_target_type not in (
    'patient',
    'doctor',
    'medical_folder',
    'report',
    'analysis',
    'admin',
    'configuration'
  ) then
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

create or replace function public.msob_touch_session(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_role text;
begin
  delete from private.app_session
  where expires_at <= pg_catalog.now();

  update private.app_session
  set expires_at = pg_catalog.now() + case
    when actor_type = 'admin' then interval '5 minutes'
    else interval '30 minutes'
  end
  where token_hash = pg_catalog.encode(
    extensions.digest(coalesce(p_token, ''), 'sha256'),
    'hex'
  )
    and expires_at > pg_catalog.now()
  returning actor_type into v_role;

  if not found then
    raise exception 'Session expirée ou invalide';
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'role', v_role
  );
end;
$function$;

revoke all on function public.msob_touch_session(text)
  from public, anon, authenticated, service_role;

grant execute on function public.msob_touch_session(text)
  to anon;

commit;
