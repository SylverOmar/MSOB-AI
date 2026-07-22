-- Cross-role access-ID isolation and Cloudflare Turnstile runtime settings.

create or replace function private.prevent_cross_role_access_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'docteur' then
    if exists (
      select 1
      from public.administrateur a
      where lower(a.admin_id) = lower(new.doctor_id)
    ) then
      raise exception using
        errcode = '23514',
        message = 'Cet identifiant est déjà utilisé par un administrateur';
    end if;
  elsif tg_table_name = 'administrateur' then
    if exists (
      select 1
      from public.docteur d
      where lower(d.doctor_id) = lower(new.admin_id)
    ) then
      raise exception using
        errcode = '23514',
        message = 'Cet identifiant est déjà utilisé par un médecin';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_doctor_admin_id_collision on public.docteur;
create trigger prevent_doctor_admin_id_collision
before insert or update of doctor_id on public.docteur
for each row execute function private.prevent_cross_role_access_id();

drop trigger if exists prevent_admin_doctor_id_collision on public.administrateur;
create trigger prevent_admin_doctor_id_collision
before insert or update of admin_id on public.administrateur
for each row execute function private.prevent_cross_role_access_id();

insert into private.runtime_setting (key, value)
values ('turnstile_site_key', '')
on conflict (key) do nothing;

create or replace function public.msob_public_runtime_config()
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  select coalesce(jsonb_object_agg(s.key, s.value), '{}'::jsonb)
  from private.runtime_setting s
  where s.key in (
    'support_email',
    'production_webhook_url',
    'test_webhook_url',
    'test_mailbox_url',
    'hosted_mcp_url',
    'hosted_mcp_queue_url',
    'groq_vision_model',
    'turnstile_site_key'
  );
$$;

revoke all on function public.msob_public_runtime_config() from public;
grant execute on function public.msob_public_runtime_config() to anon, authenticated, service_role;

create or replace function public.msob_service_runtime_config()
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  select public.msob_public_runtime_config()
    || jsonb_build_object(
      'groq_primary_key', coalesce((
        select v.decrypted_secret
        from vault.decrypted_secrets v
        where v.name = 'msob_groq_primary'
        order by v.updated_at desc
        limit 1
      ), ''),
      'groq_fallback_key', coalesce((
        select v.decrypted_secret
        from vault.decrypted_secrets v
        where v.name = 'msob_groq_fallback'
        order by v.updated_at desc
        limit 1
      ), ''),
      'turnstile_secret_key', coalesce((
        select v.decrypted_secret
        from vault.decrypted_secrets v
        where v.name = 'msob_turnstile_secret'
        order by v.updated_at desc
        limit 1
      ), '')
    );
$$;

revoke all on function public.msob_service_runtime_config() from public, anon, authenticated;
grant execute on function public.msob_service_runtime_config() to service_role;

create or replace function public.msob_owner_security_gateway(
  p_action text,
  p_token text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_actor public.administrateur%rowtype;
  v_confirm_id text;
  v_site_key text;
  v_secret text;
  v_secret_id uuid;
  v_secret_exists boolean;
begin
  delete from private.app_session where expires_at <= now();

  select a.*
  into v_actor
  from private.app_session s
  join public.administrateur a on a.id = s.actor_id
  where s.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
    and s.actor_type = 'admin'
    and s.expires_at > now();

  if not found then
    raise exception 'Session administrateur expirée ou invalide';
  end if;
  if not v_actor.is_owner then
    raise exception 'Accès réservé';
  end if;

  select exists(
    select 1 from vault.secrets where name = 'msob_turnstile_secret'
  ) into v_secret_exists;

  if v_action = 'get-turnstile' then
    return jsonb_build_object(
      'turnstile_site_key', coalesce((
        select value from private.runtime_setting where key = 'turnstile_site_key'
      ), ''),
      'turnstile_secret_configured', v_secret_exists
    );
  end if;

  if v_action <> 'save-turnstile' then
    raise exception 'Action de sécurité inconnue';
  end if;

  v_confirm_id := lower(btrim(coalesce(p_payload->>'confirmAdminId', '')));
  if v_confirm_id <> v_actor.admin_id then
    raise exception 'ID administrateur différent de la session ouverte';
  end if;

  v_site_key := btrim(coalesce(p_payload->>'turnstileSiteKey', ''));
  v_secret := btrim(coalesce(p_payload->>'turnstileSecretKey', ''));
  if v_site_key <> '' and v_site_key !~ '^[A-Za-z0-9_-]{10,100}$' then
    raise exception 'Clé publique Turnstile invalide';
  end if;
  if v_site_key <> '' and v_secret = '' and not v_secret_exists then
    raise exception 'La clé secrète Turnstile est requise pour activer la protection';
  end if;

  insert into private.runtime_setting (key, value, updated_at, updated_by)
  values ('turnstile_site_key', v_site_key, now(), v_actor.id)
  on conflict (key) do update
  set value = excluded.value,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by;

  if v_secret <> '' then
    select id into v_secret_id
    from vault.secrets
    where name = 'msob_turnstile_secret'
    order by updated_at desc
    limit 1;
    if found then
      perform vault.update_secret(v_secret_id, v_secret, null, null, null);
    else
      perform vault.create_secret(
        v_secret,
        'msob_turnstile_secret',
        'Cloudflare Turnstile server verification key for MSOB login',
        null
      );
    end if;
  end if;

  perform private.write_activity_log(
    'admin', v_actor.id, v_actor.admin_id, v_actor.prenom, v_actor.nom,
    'security.settings.updated', 'configuration', null,
    'Protection des accès', '{}'::jsonb
  );

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.msob_owner_security_gateway(text, text, jsonb) from public;
grant execute on function public.msob_owner_security_gateway(text, text, jsonb)
  to anon, authenticated, service_role;
