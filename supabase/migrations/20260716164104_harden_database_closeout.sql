begin;

-- Keep expired opaque sessions from accumulating indefinitely and support
-- efficient expiry/actor cleanup.
delete from private.app_session
where expires_at <= now();

create index if not exists app_session_expires_at_idx
  on private.app_session (expires_at);

create index if not exists app_session_actor_idx
  on private.app_session (actor_type, actor_id);

-- Required application fields remain required even if a caller bypasses the
-- browser's HTML validation.
alter table public.dossier_medical_patient
  alter column handicap set not null;

alter table public.dossier_medical_patient
  drop constraint if exists dossier_medical_patient_required_text_check;

alter table public.dossier_medical_patient
  add constraint dossier_medical_patient_required_text_check
  check (
    btrim(genre) <> ''
    and length(btrim(genre)) <= 80
    and btrim(handicap) <> ''
    and length(btrim(handicap)) <= 250
  );

alter table public.dossier_medical_document
  drop constraint if exists dossier_medical_document_payload_check;

alter table public.dossier_medical_document
  add constraint dossier_medical_document_payload_check
  check (
    btrim(nom_fichier) <> ''
    and (
      (
        contenu is not null
        and btrim(contenu) <> ''
        and chemin_stockage is null
      )
      or
      (
        contenu is null
        and chemin_stockage is not null
        and btrim(chemin_stockage) <> ''
        and type_mime is not null
        and btrim(type_mime) <> ''
        and taille_octets is not null
      )
    )
  );

alter table public.rapport
  drop constraint if exists rapport_text_nonblank_check;

alter table public.rapport
  add constraint rapport_text_nonblank_check
  check (btrim(rapport_text) <> '');

alter table public.docteur
  drop constraint if exists docteur_name_normalization_check;

alter table public.docteur
  add constraint docteur_name_normalization_check
  check (
    btrim(prenom) <> ''
    and btrim(nom) <> ''
    and prenom = initcap(lower(btrim(prenom)))
    and nom = upper(btrim(nom))
  );

alter table public.administrateur
  drop constraint if exists administrateur_name_normalization_check;

alter table public.administrateur
  add constraint administrateur_name_normalization_check
  check (
    btrim(prenom) <> ''
    and btrim(nom) <> ''
    and prenom = initcap(lower(btrim(prenom)))
    and nom = upper(btrim(nom))
  );

create or replace function public.secure_create_patient(
  p_cin text,
  p_prenom text,
  p_nom text,
  p_age integer,
  p_genre character varying,
  p_handicap character varying
)
returns uuid
language plpgsql
security definer
set search_path = public, private, extensions, pg_catalog
as $function$
declare
  new_id uuid;
  v_cin text := upper(btrim(p_cin));
  v_prenom text := initcap(lower(btrim(p_prenom)));
  v_nom text := upper(btrim(p_nom));
  v_genre text := btrim(p_genre);
  v_handicap text := btrim(p_handicap);
begin
  if v_cin is null or v_cin !~ '^[A-Z]{1,2}[0-9]{5,6}$' then
    raise exception 'CIN invalide';
  end if;
  if v_prenom is null or v_prenom = '' then
    raise exception 'Prénom requis';
  end if;
  if v_nom is null or v_nom = '' then
    raise exception 'Nom requis';
  end if;
  if p_age is null or p_age < 0 or p_age > 150 then
    raise exception 'Âge invalide';
  end if;
  if v_genre is null or v_genre = '' or length(v_genre) > 80 then
    raise exception 'Genre requis';
  end if;
  if v_handicap is null or v_handicap = '' or length(v_handicap) > 250 then
    raise exception 'Handicap requis';
  end if;

  insert into public.dossier_medical_patient (
    cin_hash,
    cin_encrypted,
    prenom_encrypted,
    nom_encrypted,
    age,
    genre,
    handicap
  )
  values (
    encode(extensions.digest(v_cin, 'sha256'), 'hex'),
    encode(
      extensions.pgp_sym_encrypt(
        v_cin,
        private.pii_key(),
        'cipher-algo=aes256,compress-algo=0'
      ),
      'base64'
    ),
    encode(
      extensions.pgp_sym_encrypt(
        v_prenom,
        private.pii_key(),
        'cipher-algo=aes256,compress-algo=0'
      ),
      'base64'
    ),
    encode(
      extensions.pgp_sym_encrypt(
        v_nom,
        private.pii_key(),
        'cipher-algo=aes256,compress-algo=0'
      ),
      'base64'
    ),
    p_age,
    v_genre,
    v_handicap
  )
  returning id into new_id;

  return new_id;
end;
$function$;

create or replace function public.secure_update_patient(
  p_id uuid,
  p_cin text,
  p_prenom text,
  p_nom text,
  p_age integer,
  p_genre character varying,
  p_handicap character varying
)
returns void
language plpgsql
security definer
set search_path = public, private, extensions, pg_catalog
as $function$
declare
  v_cin text := upper(btrim(p_cin));
  v_prenom text := initcap(lower(btrim(p_prenom)));
  v_nom text := upper(btrim(p_nom));
  v_genre text := btrim(p_genre);
  v_handicap text := btrim(p_handicap);
begin
  if v_cin is null or v_cin !~ '^[A-Z]{1,2}[0-9]{5,6}$' then
    raise exception 'CIN invalide';
  end if;
  if v_prenom is null or v_prenom = '' then
    raise exception 'Prénom requis';
  end if;
  if v_nom is null or v_nom = '' then
    raise exception 'Nom requis';
  end if;
  if p_age is null or p_age < 0 or p_age > 150 then
    raise exception 'Âge invalide';
  end if;
  if v_genre is null or v_genre = '' or length(v_genre) > 80 then
    raise exception 'Genre requis';
  end if;
  if v_handicap is null or v_handicap = '' or length(v_handicap) > 250 then
    raise exception 'Handicap requis';
  end if;

  update public.dossier_medical_patient
  set
    cin_hash = encode(extensions.digest(v_cin, 'sha256'), 'hex'),
    cin_encrypted = encode(
      extensions.pgp_sym_encrypt(
        v_cin,
        private.pii_key(),
        'cipher-algo=aes256,compress-algo=0'
      ),
      'base64'
    ),
    prenom_encrypted = encode(
      extensions.pgp_sym_encrypt(
        v_prenom,
        private.pii_key(),
        'cipher-algo=aes256,compress-algo=0'
      ),
      'base64'
    ),
    nom_encrypted = encode(
      extensions.pgp_sym_encrypt(
        v_nom,
        private.pii_key(),
        'cipher-algo=aes256,compress-algo=0'
      ),
      'base64'
    ),
    age = p_age,
    genre = v_genre,
    handicap = v_handicap
  where id = p_id;

  if not found then
    raise exception 'Patient introuvable';
  end if;
end;
$function$;

create or replace function public.msob_gateway(
  p_action text,
  p_token text default null,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, extensions, pg_catalog
as $function$
declare
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_role text;
  v_actor_id uuid;
  v_token text;
  v_token_hash text;
  v_actor record;
  v_patients jsonb;
  v_reports jsonb;
  v_documents jsonb;
  v_doctors jsonb;
  v_id text;
  v_confirm_id text;
  v_patient jsonb;
  v_doctor jsonb;
  v_report_text text;
  v_dossier_id uuid;
  v_target_doctor_id uuid;
  v_version integer;
begin
  -- Expired opaque sessions have no further value and are removed whenever
  -- the gateway is used.
  delete from private.app_session
  where expires_at <= now();

  if v_action = 'unlock' then
    v_role := lower(btrim(coalesce(p_payload->>'role', '')));
    if v_role not in ('doctor', 'admin') then
      raise exception 'Espace invalide';
    end if;

    v_id := lower(btrim(coalesce(p_payload->>'id', '')));
    if
      v_id !~ '^[a-z0-9]{8,10}$'
      or v_id !~ '[a-z]'
      or v_id !~ '[0-9]'
    then
      raise exception 'Identifiant invalide';
    end if;

    if v_role = 'admin' then
      select id, prenom, nom
      into v_actor
      from public.administrateur
      where admin_id = v_id;
    else
      select id, prenom, nom
      into v_actor
      from public.docteur
      where doctor_id = v_id;
    end if;

    if not found then
      raise exception 'Identifiant non accepté';
    end if;

    v_token := encode(extensions.gen_random_bytes(32), 'hex');
    v_token_hash := encode(extensions.digest(v_token, 'sha256'), 'hex');

    insert into private.app_session (
      actor_type,
      actor_id,
      token_hash,
      expires_at
    )
    values (
      v_role,
      v_actor.id,
      v_token_hash,
      now() + interval '30 minutes'
    );

    return jsonb_build_object(
      'sessionToken',
      v_token,
      'role',
      v_role,
      'actor',
      jsonb_build_object(
        'id',
        v_actor.id,
        'prenom',
        v_actor.prenom,
        'nom',
        v_actor.nom
      )
    );
  end if;

  if p_token is null or p_token = '' then
    raise exception 'Session requise';
  end if;

  select actor_type, actor_id
  into v_role, v_actor_id
  from private.app_session
  where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    and expires_at > now();

  if not found then
    raise exception 'Session expirée ou invalide';
  end if;

  if v_action = 'touch-session' then
    if v_role <> 'doctor' then
      raise exception 'Accès médecin requis';
    end if;

    update private.app_session
    set expires_at = now() + interval '30 minutes'
    where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');

    return jsonb_build_object('ok', true);
  end if;

  if v_action = 'doctor-data' then
    if v_role <> 'doctor' then
      raise exception 'Accès médecin requis';
    end if;

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
      'patients',
      v_patients,
      'reports',
      v_reports,
      'documents',
      v_documents
    );
  end if;

  if v_action in ('update-patient', 'create-patient', 'save-report') then
    if v_role <> 'doctor' then
      raise exception 'Accès médecin requis';
    end if;

    select doctor_id
    into v_id
    from public.docteur
    where id = v_actor_id;

    if not found then
      raise exception 'Médecin introuvable';
    end if;

    v_confirm_id := lower(btrim(coalesce(p_payload->>'confirmDoctorId', '')));
    if v_confirm_id <> v_id then
      raise exception 'ID médecin différent de la session ouverte';
    end if;

    if v_action = 'update-patient' then
      v_patient := p_payload->'patient';
      perform public.secure_update_patient(
        (v_patient->>'id')::uuid,
        v_patient->>'cin',
        v_patient->>'prenom',
        v_patient->>'nom',
        (v_patient->>'age')::integer,
        v_patient->>'genre',
        v_patient->>'handicap'
      );
      v_dossier_id := (v_patient->>'id')::uuid;
    elsif v_action = 'create-patient' then
      v_patient := p_payload->'patient';
      v_dossier_id := public.secure_create_patient(
        v_patient->>'cin',
        v_patient->>'prenom',
        v_patient->>'nom',
        (v_patient->>'age')::integer,
        v_patient->>'genre',
        v_patient->>'handicap'
      );
    else
      v_dossier_id := (p_payload->>'dossierId')::uuid;
      v_report_text := nullif(btrim(p_payload->>'reportText'), '');

      if v_report_text is null then
        raise exception 'Rapport requis';
      end if;
      if not exists (
        select 1
        from public.dossier_medical_patient
        where id = v_dossier_id
      ) then
        raise exception 'Dossier patient introuvable';
      end if;

      select coalesce(max(version), 0) + 1
      into v_version
      from public.rapport
      where dossier_id = v_dossier_id;

      insert into public.rapport (
        dossier_id,
        rapport_text,
        date_generation,
        statut,
        version
      )
      values (
        v_dossier_id,
        v_report_text,
        now(),
        'confirme',
        v_version
      );
    end if;

    return jsonb_build_object('ok', true, 'dossierId', v_dossier_id);
  end if;

  if v_role <> 'admin' then
    raise exception 'Accès administrateur requis';
  end if;

  if v_action = 'list-doctors' then
    select coalesce(
      jsonb_agg(to_jsonb(d) order by d.prenom, d.nom),
      '[]'::jsonb
    )
    into v_doctors
    from (
      select id, prenom, nom, doctor_id, date_creation
      from public.docteur
    ) d;

    return jsonb_build_object('doctors', v_doctors);
  end if;

  -- Per the application rule, any currently authorized administrator may
  -- confirm a doctor-management mutation.
  v_confirm_id := lower(btrim(coalesce(p_payload->>'confirmAdminId', '')));
  if not exists (
    select 1
    from public.administrateur
    where admin_id = v_confirm_id
  ) then
    raise exception 'ID administrateur non accepté';
  end if;

  if v_action = 'save-doctor' then
    v_doctor := p_payload->'doctor';
    v_id := lower(btrim(coalesce(v_doctor->>'doctor_id', '')));

    if
      v_id !~ '^[a-z0-9]{8,10}$'
      or v_id !~ '[a-z]'
      or v_id !~ '[0-9]'
    then
      raise exception 'ID médecin invalide';
    end if;

    if
      nullif(btrim(v_doctor->>'prenom'), '') is null
      or nullif(btrim(v_doctor->>'nom'), '') is null
    then
      raise exception 'Prénom et nom requis';
    end if;

    if nullif(v_doctor->>'id', '') is null then
      insert into public.docteur (prenom, nom, doctor_id)
      values (
        initcap(lower(btrim(v_doctor->>'prenom'))),
        upper(btrim(v_doctor->>'nom')),
        v_id
      );
    else
      update public.docteur
      set
        prenom = initcap(lower(btrim(v_doctor->>'prenom'))),
        nom = upper(btrim(v_doctor->>'nom')),
        doctor_id = v_id
      where id = (v_doctor->>'id')::uuid;

      if not found then
        raise exception 'Médecin introuvable';
      end if;
    end if;

    return jsonb_build_object('ok', true);
  end if;

  if v_action = 'delete-doctor' then
    v_target_doctor_id := (p_payload->>'doctorId')::uuid;

    delete from private.app_session
    where actor_type = 'doctor'
      and actor_id = v_target_doctor_id;

    delete from public.docteur
    where id = v_target_doctor_id;

    if not found then
      raise exception 'Médecin introuvable';
    end if;

    return jsonb_build_object('ok', true);
  end if;

  raise exception 'Action inconnue';
end;
$function$;

-- Browser traffic uses the publishable/anon role. The Edge Function uses the
-- server-only service role. Supabase Auth's authenticated role is not part of
-- this custom opaque-session design.
revoke all
  on function public.msob_gateway(text, text, jsonb)
  from public, authenticated;

grant execute
  on function public.msob_gateway(text, text, jsonb)
  to anon, service_role;

-- Internal PII routines are callable only by their postgres owner. The gateway
-- invokes them while running as that owner.
revoke all
  on function public.secure_create_patient(
    text,
    text,
    text,
    integer,
    character varying,
    character varying
  )
  from public, anon, authenticated, service_role;

revoke all
  on function public.secure_update_patient(
    uuid,
    text,
    text,
    text,
    integer,
    character varying,
    character varying
  )
  from public, anon, authenticated, service_role;

revoke all
  on function public.secure_patient_list()
  from public, anon, authenticated, service_role;

revoke all
  on function public.secure_encrypt_existing_patient_pii()
  from public, anon, authenticated, service_role;

-- Remove unrelated legacy table privileges. Keep only the exact grants used
-- by the private-file Edge Function and its rollback path.
revoke truncate, references, trigger
  on table
    public.administrateur,
    public.docteur,
    public.dossier_medical_patient,
    public.dossier_medical_document,
    public.rapport
  from service_role;

commit;
