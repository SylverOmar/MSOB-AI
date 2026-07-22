-- Owner-only administration, runtime configuration and persistent hosted MCP queue.

alter table public.administrateur
  add column if not exists is_owner boolean not null default false;

update public.administrateur
set is_owner = true
where lower(prenom) = 'omar'
  and upper(nom) = 'CHAKIR';

do $$
begin
  if not exists (
    select 1 from public.administrateur where is_owner
  ) then
    raise exception 'The Omar CHAKIR owner administrator record was not found';
  end if;
end;
$$;

create unique index if not exists administrateur_single_owner_idx
  on public.administrateur (is_owner)
  where is_owner;

create table if not exists private.runtime_setting (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.administrateur(id) on delete set null,
  constraint runtime_setting_key_format check (key ~ '^[a-z][a-z0-9_]{2,63}$')
);

alter table private.runtime_setting enable row level security;
revoke all on private.runtime_setting from public, anon, authenticated;

insert into private.runtime_setting (key, value)
values
  ('support_email', 'support@msob.ai'),
  ('production_webhook_url', 'https://stg-agentic.abafusion.ai/api/v1/webhook/7cec66ec-44b2-4533-a0c4-09b0fb379465'),
  ('test_webhook_url', 'https://stg-agentic.abafusion.ai/api/v1/webhook/fc3a3d9d-43d9-4b2a-b6b7-5704af3814a2'),
  ('test_mailbox_url', 'https://ntfy.sh/inqnyoqqhtogrvgjyavo/json?poll=1'),
  ('hosted_mcp_url', 'https://msob-ai.vercel.app/api/mcp'),
  ('hosted_mcp_queue_url', 'https://inqnyoqqhtogrvgjyavo.supabase.co/functions/v1/msob-medical-files'),
  ('groq_vision_model', 'meta-llama/llama-4-scout-17b-16e-instruct')
on conflict (key) do nothing;

create table if not exists private.clinical_request_queue (
  request_id text primary key,
  created_by uuid not null references public.docteur(id) on delete cascade,
  status text not null default 'queued',
  claim_token_hash text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '6 hours'),
  constraint clinical_request_queue_id_format
    check (request_id ~ '^[A-Za-z0-9_-]{8,80}$'),
  constraint clinical_request_queue_status
    check (status in ('queued', 'processing'))
);

create table if not exists private.clinical_file_queue (
  id uuid primary key default extensions.gen_random_uuid(),
  request_id text not null references private.clinical_request_queue(request_id) on delete cascade,
  original_name text not null,
  source text not null,
  content_type text not null default 'application/octet-stream',
  size_bytes bigint not null,
  storage_path text not null unique,
  created_at timestamptz not null default now(),
  constraint clinical_file_queue_source check (source in ('case', 'medical-folder')),
  constraint clinical_file_queue_size check (size_bytes > 0 and size_bytes <= 26214400)
);

create index if not exists clinical_request_queue_actor_idx
  on private.clinical_request_queue(created_by, created_at desc);
create index if not exists clinical_request_queue_expiry_idx
  on private.clinical_request_queue(expires_at);
create index if not exists clinical_file_queue_request_idx
  on private.clinical_file_queue(request_id, created_at);

alter table private.clinical_request_queue enable row level security;
alter table private.clinical_file_queue enable row level security;
revoke all on private.clinical_request_queue from public, anon, authenticated;
revoke all on private.clinical_file_queue from public, anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit)
values ('clinical-analysis-queue', 'clinical-analysis-queue', false, 26214400)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit;

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
    'groq_vision_model'
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
      ), '')
    );
$$;

revoke all on function public.msob_service_runtime_config() from public, anon, authenticated;
grant execute on function public.msob_service_runtime_config() to service_role;

create or replace function public.msob_owner_gateway(
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
  v_settings jsonb;
  v_item record;
  v_value text;
  v_primary text;
  v_fallback text;
  v_secret_id uuid;
  v_admin jsonb;
  v_target public.administrateur%rowtype;
  v_target_id uuid;
  v_access_id text;
  v_prenom text;
  v_nom text;
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

  if v_action = 'capabilities' then
    return jsonb_build_object('owner', true);
  end if;

  if v_action = 'get-settings' then
    return jsonb_build_object(
      'settings', public.msob_public_runtime_config(),
      'groq_primary_configured', exists(
        select 1 from vault.secrets where name = 'msob_groq_primary'
      ),
      'groq_fallback_configured', exists(
        select 1 from vault.secrets where name = 'msob_groq_fallback'
      )
    );
  end if;

  if v_action = 'list-admins' then
    return jsonb_build_object(
      'admins', coalesce((
        select jsonb_agg(to_jsonb(x) order by x.prenom, x.nom)
        from (
          select id, prenom, nom, admin_id, is_owner, date_creation
          from public.administrateur
        ) x
      ), '[]'::jsonb)
    );
  end if;

  v_confirm_id := lower(btrim(coalesce(p_payload->>'confirmAdminId', '')));
  if v_confirm_id <> v_actor.admin_id then
    raise exception 'ID administrateur différent de la session ouverte';
  end if;

  if v_action = 'save-settings' then
    v_settings := coalesce(p_payload->'settings', '{}'::jsonb);
    if jsonb_typeof(v_settings) <> 'object' then
      raise exception 'Configuration invalide';
    end if;

    for v_item in select key, value from jsonb_each_text(v_settings)
    loop
      if v_item.key not in (
        'support_email',
        'production_webhook_url',
        'test_webhook_url',
        'test_mailbox_url',
        'hosted_mcp_url',
        'hosted_mcp_queue_url',
        'groq_vision_model'
      ) then
        raise exception 'Paramètre non autorisé: %', v_item.key;
      end if;
      v_value := btrim(v_item.value);
      if v_value = '' then
        raise exception 'Le paramètre % est requis', v_item.key;
      end if;
      if v_item.key = 'support_email'
         and v_value !~* '^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$' then
        raise exception 'Adresse e-mail invalide';
      end if;
      if v_item.key in (
        'production_webhook_url',
        'test_webhook_url',
        'test_mailbox_url',
        'hosted_mcp_url',
        'hosted_mcp_queue_url'
      ) and v_value !~ '^https://[^[:space:]]+$' then
        raise exception 'Une adresse HTTPS valide est requise pour %', v_item.key;
      end if;

      insert into private.runtime_setting (key, value, updated_at, updated_by)
      values (v_item.key, v_value, now(), v_actor.id)
      on conflict (key) do update
      set value = excluded.value,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by;
    end loop;

    v_primary := btrim(coalesce(p_payload->>'groqPrimaryKey', ''));
    if v_primary <> '' then
      select id into v_secret_id
      from vault.secrets
      where name = 'msob_groq_primary'
      order by updated_at desc
      limit 1;
      if found then
        perform vault.update_secret(v_secret_id, v_primary, null, null, null);
      else
        perform vault.create_secret(v_primary, 'msob_groq_primary', 'Primary Groq key for MSOB hosted MCP vision extraction', null);
      end if;
    end if;

    v_fallback := btrim(coalesce(p_payload->>'groqFallbackKey', ''));
    if v_fallback <> '' then
      select id into v_secret_id
      from vault.secrets
      where name = 'msob_groq_fallback'
      order by updated_at desc
      limit 1;
      if found then
        perform vault.update_secret(v_secret_id, v_fallback, null, null, null);
      else
        perform vault.create_secret(v_fallback, 'msob_groq_fallback', 'Fallback Groq key for MSOB hosted MCP vision extraction', null);
      end if;
    end if;

    perform private.write_activity_log(
      'admin', v_actor.id, v_actor.admin_id, v_actor.prenom, v_actor.nom,
      'settings.updated', 'configuration', null, 'Configuration applicative', '{}'::jsonb
    );
    return jsonb_build_object('ok', true);
  end if;

  if v_action = 'save-admin' then
    v_admin := p_payload->'admin';
    if v_admin is null or jsonb_typeof(v_admin) <> 'object' then
      raise exception 'Informations administrateur invalides';
    end if;
    v_prenom := initcap(lower(btrim(coalesce(v_admin->>'prenom', ''))));
    v_nom := upper(btrim(coalesce(v_admin->>'nom', '')));
    v_access_id := lower(btrim(coalesce(v_admin->>'admin_id', '')));
    if v_prenom = '' or v_nom = '' then
      raise exception 'Prénom et nom requis';
    end if;
    if v_access_id !~ '^[a-z0-9]{8,10}$'
       or v_access_id !~ '[a-z]'
       or v_access_id !~ '[0-9]' then
      raise exception 'ID administrateur invalide';
    end if;

    if nullif(v_admin->>'id', '') is null then
      insert into public.administrateur (prenom, nom, admin_id, is_owner)
      values (v_prenom, v_nom, v_access_id, false)
      returning * into v_target;
      v_action := 'admin.created';
    else
      v_target_id := (v_admin->>'id')::uuid;
      update public.administrateur
      set prenom = v_prenom,
          nom = v_nom,
          admin_id = v_access_id
      where id = v_target_id
      returning * into v_target;
      if not found then
        raise exception 'Administrateur introuvable';
      end if;
      v_action := 'admin.updated';
    end if;

    perform private.write_activity_log(
      'admin', v_actor.id, v_actor.admin_id, v_actor.prenom, v_actor.nom,
      v_action, 'admin', v_target.id::text,
      v_target.prenom || ' ' || v_target.nom, '{}'::jsonb
    );
    return jsonb_build_object(
      'ok', true,
      'admin', jsonb_build_object(
        'id', v_target.id,
        'prenom', v_target.prenom,
        'nom', v_target.nom,
        'admin_id', v_target.admin_id,
        'is_owner', v_target.is_owner,
        'date_creation', v_target.date_creation
      )
    );
  end if;

  if v_action = 'delete-admin' then
    v_target_id := (p_payload->>'adminId')::uuid;
    select * into v_target
    from public.administrateur
    where id = v_target_id;
    if not found then
      raise exception 'Administrateur introuvable';
    end if;
    if v_target.is_owner then
      raise exception 'Ce compte administrateur ne peut pas être supprimé';
    end if;

    delete from private.app_session
    where actor_type = 'admin' and actor_id = v_target.id;
    delete from public.administrateur where id = v_target.id;

    perform private.write_activity_log(
      'admin', v_actor.id, v_actor.admin_id, v_actor.prenom, v_actor.nom,
      'admin.deleted', 'admin', v_target.id::text,
      v_target.prenom || ' ' || v_target.nom, '{}'::jsonb
    );
    return jsonb_build_object('ok', true, 'admin_id', v_target.id);
  end if;

  raise exception 'Action propriétaire inconnue';
end;
$$;

revoke all on function public.msob_owner_gateway(text, text, jsonb) from public;
grant execute on function public.msob_owner_gateway(text, text, jsonb) to anon, authenticated, service_role;

create or replace function public.msob_queue_add(
  p_token text,
  p_request_id text,
  p_original_name text,
  p_source text,
  p_content_type text,
  p_size_bytes bigint,
  p_storage_path text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_file_id uuid;
begin
  select actor_id into v_actor_id
  from private.app_session
  where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
    and actor_type = 'doctor'
    and expires_at > now();
  if not found then raise exception 'Session médecin expirée ou invalide'; end if;

  insert into private.clinical_request_queue (request_id, created_by)
  values (p_request_id, v_actor_id)
  on conflict (request_id) do nothing;

  if not exists (
    select 1 from private.clinical_request_queue
    where request_id = p_request_id
      and created_by = v_actor_id
      and status = 'queued'
      and expires_at > now()
  ) then
    raise exception 'File clinique temporaire invalide';
  end if;

  insert into private.clinical_file_queue (
    request_id, original_name, source, content_type, size_bytes, storage_path
  ) values (
    p_request_id,
    left(btrim(p_original_name), 180),
    p_source,
    coalesce(nullif(btrim(p_content_type), ''), 'application/octet-stream'),
    p_size_bytes,
    p_storage_path
  ) returning id into v_file_id;
  return v_file_id;
end;
$$;

create or replace function public.msob_queue_clear(
  p_token text,
  p_request_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_paths jsonb;
begin
  select actor_id into v_actor_id
  from private.app_session
  where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
    and actor_type = 'doctor'
    and expires_at > now();
  if not found then raise exception 'Session médecin expirée ou invalide'; end if;

  select coalesce(jsonb_agg(f.storage_path), '[]'::jsonb)
  into v_paths
  from private.clinical_file_queue f
  join private.clinical_request_queue q on q.request_id = f.request_id
  where q.created_by = v_actor_id
    and (p_request_id is null or q.request_id = p_request_id);

  delete from private.clinical_request_queue q
  where q.created_by = v_actor_id
    and (p_request_id is null or q.request_id = p_request_id);
  return jsonb_build_object('storage_paths', v_paths);
end;
$$;

create or replace function public.msob_queue_status(p_token text, p_request_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_actor_id uuid;
begin
  select actor_id into v_actor_id
  from private.app_session
  where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
    and actor_type = 'doctor'
    and expires_at > now();
  if not found then raise exception 'Session médecin expirée ou invalide'; end if;

  return jsonb_build_object(
    'request_id', p_request_id,
    'count', (
      select count(*) from private.clinical_file_queue f
      join private.clinical_request_queue q on q.request_id = f.request_id
      where q.request_id = p_request_id and q.created_by = v_actor_id
    ),
    'files', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', f.original_name, 'source', f.source, 'size', f.size_bytes
      ) order by f.created_at)
      from private.clinical_file_queue f
      join private.clinical_request_queue q on q.request_id = f.request_id
      where q.request_id = p_request_id and q.created_by = v_actor_id
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.msob_queue_claim(p_request_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim_token text;
  v_files jsonb;
begin
  if not exists (
    select 1 from private.clinical_request_queue
    where request_id = p_request_id and expires_at > now()
  ) then
    raise exception 'File clinique temporaire introuvable ou expirée';
  end if;
  v_claim_token := encode(extensions.gen_random_bytes(32), 'hex');
  update private.clinical_request_queue
  set status = 'processing',
      claim_token_hash = encode(extensions.digest(v_claim_token, 'sha256'), 'hex')
  where request_id = p_request_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', f.id,
    'name', f.original_name,
    'source', f.source,
    'content_type', f.content_type,
    'size', f.size_bytes,
    'storage_path', f.storage_path
  ) order by f.created_at), '[]'::jsonb)
  into v_files
  from private.clinical_file_queue f
  where f.request_id = p_request_id;

  return jsonb_build_object(
    'request_id', p_request_id,
    'claim_token', v_claim_token,
    'files', v_files
  );
end;
$$;

create or replace function public.msob_queue_verify_claim(
  p_request_id text,
  p_claim_token text
)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from private.clinical_request_queue q
    where q.request_id = p_request_id
      and q.status = 'processing'
      and q.expires_at > now()
      and q.claim_token_hash = encode(extensions.digest(coalesce(p_claim_token, ''), 'sha256'), 'hex')
  );
$$;

create or replace function public.msob_queue_finalize(
  p_request_id text,
  p_claim_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_paths jsonb;
begin
  if not public.msob_queue_verify_claim(p_request_id, p_claim_token) then
    raise exception 'Jeton de traitement temporaire invalide';
  end if;
  select coalesce(jsonb_agg(storage_path), '[]'::jsonb)
  into v_paths
  from private.clinical_file_queue
  where request_id = p_request_id;
  delete from private.clinical_request_queue where request_id = p_request_id;
  return jsonb_build_object('storage_paths', v_paths);
end;
$$;

create or replace function public.msob_queue_prune()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_paths jsonb;
begin
  select coalesce(jsonb_agg(f.storage_path), '[]'::jsonb)
  into v_paths
  from private.clinical_file_queue f
  join private.clinical_request_queue q on q.request_id = f.request_id
  where q.expires_at <= now();
  delete from private.clinical_request_queue where expires_at <= now();
  return jsonb_build_object('storage_paths', v_paths);
end;
$$;

revoke all on function public.msob_queue_add(text, text, text, text, text, bigint, text) from public, anon, authenticated;
revoke all on function public.msob_queue_clear(text, text) from public, anon, authenticated;
revoke all on function public.msob_queue_status(text, text) from public, anon, authenticated;
revoke all on function public.msob_queue_claim(text) from public, anon, authenticated;
revoke all on function public.msob_queue_verify_claim(text, text) from public, anon, authenticated;
revoke all on function public.msob_queue_finalize(text, text) from public, anon, authenticated;
revoke all on function public.msob_queue_prune() from public, anon, authenticated;
grant execute on function public.msob_queue_add(text, text, text, text, text, bigint, text) to service_role;
grant execute on function public.msob_queue_clear(text, text) to service_role;
grant execute on function public.msob_queue_status(text, text) to service_role;
grant execute on function public.msob_queue_claim(text) to service_role;
grant execute on function public.msob_queue_verify_claim(text, text) to service_role;
grant execute on function public.msob_queue_finalize(text, text) to service_role;
grant execute on function public.msob_queue_prune() to service_role;

create or replace function public.msob_list_activity(
  p_token text,
  p_limit integer default 250
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid;
  v_is_owner boolean;
  v_limit integer := least(greatest(coalesce(p_limit, 250), 1), 500);
  v_logs jsonb;
begin
  delete from private.app_session where expires_at <= now();
  select s.actor_id, a.is_owner
  into v_actor_id, v_is_owner
  from private.app_session s
  join public.administrateur a on a.id = s.actor_id
  where s.token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    and s.actor_type = 'admin'
    and s.expires_at > now();
  if not found then raise exception 'Session administrateur expirée ou invalide'; end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
  into v_logs
  from (
    select
      l.id,
      l.created_at,
      l.actor_type,
      case
        when l.actor_type = 'admin' and not v_is_owner then
          left(l.actor_access_id, 3) || repeat('*', greatest(length(l.actor_access_id) - 3, 1))
        else l.actor_access_id
      end as actor_access_id,
      l.actor_prenom,
      l.actor_nom,
      l.action,
      l.target_type,
      l.target_id,
      case
        when l.target_label_encrypted is null then null
        else extensions.pgp_sym_decrypt(
          decode(l.target_label_encrypted, 'base64'), private.pii_key()
        )
      end as target_label,
      l.details
    from private.activity_log l
    order by l.created_at desc
    limit v_limit
  ) x;
  return jsonb_build_object('logs', v_logs, 'owner_view', v_is_owner);
end;
$$;

revoke all on function public.msob_list_activity(text, integer) from public;
grant execute on function public.msob_list_activity(text, integer) to service_role;
