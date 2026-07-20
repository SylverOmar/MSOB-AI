import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "medical-folder";
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const ALLOWED_ORIGINS = new Set([
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "https://msob-ai.vercel.app",
  "https://msob-ai-zeus100-projects.vercel.app",
  "https://msob-ai-git-main-zeus100-projects.vercel.app",
]);

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
let bucketReady: Promise<void> | null = null;

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "null",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-msob-session, x-msob-confirm-id",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function requiredHeader(request: Request, name: string): string {
  const value = request.headers.get(name)?.trim();
  if (!value) throw new HttpError(401, "Votre session n'est pas valide.");
  return value;
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeCin(value: unknown): string {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
}

function safeOriginalName(value: unknown): string {
  const name = String(value || "document").split(/[\\/]/).pop()?.trim() || "document";
  return name.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "_").slice(0, 180);
}

function storageExtension(name: string): string {
  const match = name.match(/(\.[A-Za-z0-9]{1,12})$/);
  return match ? match[1].toLowerCase() : "";
}

function gatewayErrorMessage(payload: Record<string, unknown>, status: number): string {
  return String(
    payload.message
      || payload.error
      || payload.details
      || `La demande Supabase a échoué (${status}).`
  );
}

function ensurePrivateBucket(): Promise<void> {
  if (bucketReady) return bucketReady;
  bucketReady = (async () => {
    const { data: buckets, error: listError } = await admin.storage.listBuckets();
    if (listError) throw new HttpError(500, "Le stockage privé n'est pas disponible.");
    const existing = (buckets || []).find((bucket) => bucket.id === BUCKET);
    if (!existing) {
      const { error } = await admin.storage.createBucket(BUCKET, {
        public: false,
        fileSizeLimit: MAX_FILE_BYTES,
      });
      if (error) throw new HttpError(500, "Le stockage privé n'a pas pu être créé.");
      return;
    }
    if (existing.public || existing.file_size_limit !== MAX_FILE_BYTES) {
      const { error } = await admin.storage.updateBucket(BUCKET, {
        public: false,
        fileSizeLimit: MAX_FILE_BYTES,
      });
      if (error) throw new HttpError(500, "Le stockage privé n'a pas pu être sécurisé.");
    }
  })().catch((error) => {
    bucketReady = null;
    throw error;
  });
  return bucketReady;
}

async function callGateway(
  action: string,
  token: string | null,
  payload: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/msob_gateway`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({
      p_action: action,
      p_token: token,
      p_payload: payload,
    }),
  });
  const raw = await response.text();
  let data: Record<string, unknown> = {};
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { message: raw };
    }
  }
  if (!response.ok) throw new HttpError(response.status, gatewayErrorMessage(data, response.status));
  return data;
}

async function callAdminPatientGateway(
  action: string,
  token: string,
  payload: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/msob_admin_patient_gateway`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({
      p_action: action,
      p_token: token,
      p_payload: payload,
    }),
  });
  const raw = await response.text();
  let data: Record<string, unknown> = {};
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { message: raw };
    }
  }
  if (!response.ok) throw new HttpError(response.status, gatewayErrorMessage(data, response.status));
  return data;
}

async function recordActivity(
  token: string,
  action: string,
  targetType: string,
  targetId: string | null,
  targetLabel: string | null,
  details: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await admin.rpc("msob_record_activity", {
    p_token: token,
    p_action: action,
    p_target_type: targetType,
    p_target_id: targetId,
    p_target_label: targetLabel,
    p_details: details,
  });
  if (error) throw new HttpError(500, "L'action a été effectuée, mais son journal n'a pas pu être enregistré.");
}

async function createPatientAsAdmin(
  token: string,
  confirmAdminId: string,
  patient: Partial<Patient>,
): Promise<string> {
  const { data, error } = await admin.rpc("msob_admin_create_patient", {
    p_token: token,
    p_confirm_admin_id: confirmAdminId,
    p_patient: patient,
  });
  if (error) throw new HttpError(400, error.message || "Le patient n'a pas pu être ajouté.");
  const patientId = String((data as Record<string, unknown> | null)?.patient_id || "");
  if (!validUuid(patientId)) throw new HttpError(500, "L'identifiant du nouveau patient est introuvable.");
  return patientId;
}

function patientAuditLabel(patient: Patient): string {
  return `${patient.prenom} ${patient.nom} - ${patient.cin}`;
}

function doctorAuditLabel(doctor: Record<string, unknown>): string {
  return `${String(doctor.prenom || "")} ${String(doctor.nom || "")} - ${String(doctor.doctor_id || "")}`.trim();
}

type Patient = {
  id: string;
  cin: string;
  prenom: string;
  nom: string;
  age: number;
  genre: string;
  handicap: string;
};

type MedicalDocument = {
  id: string;
  dossier_id: string;
  nom_fichier: string | null;
  type_mime: string | null;
  taille_octets: number | null;
  chemin_stockage: string | null;
  contenu: string | null;
};

type DoctorData = {
  patients: Patient[];
  documents: MedicalDocument[];
};

async function loadDoctorData(token: string): Promise<DoctorData> {
  const raw = await callGateway("doctor-data", token);
  return {
    patients: Array.isArray(raw.patients) ? raw.patients as Patient[] : [],
    documents: Array.isArray(raw.documents) ? raw.documents as MedicalDocument[] : [],
  };
}

async function loadAdminPatientData(token: string): Promise<DoctorData & { reports: Record<string, unknown>[] }> {
  const raw = await callAdminPatientGateway("data", token);
  return {
    patients: Array.isArray(raw.patients) ? raw.patients as Patient[] : [],
    documents: Array.isArray(raw.documents) ? raw.documents as MedicalDocument[] : [],
    reports: Array.isArray(raw.reports) ? raw.reports as Record<string, unknown>[] : [],
  };
}

async function loadAccessibleData(token: string): Promise<DoctorData> {
  try {
    return await loadDoctorData(token);
  } catch {
    try {
      return await loadAdminPatientData(token);
    } catch {
      throw new HttpError(401, "Votre session n'est pas valide.");
    }
  }
}

function findPatient(data: DoctorData, dossierId: string): Patient {
  const patient = data.patients.find((item) => item.id === dossierId);
  if (!patient) throw new HttpError(404, "Dossier patient introuvable.");
  return patient;
}

async function validateDoctorConfirmation(
  token: string,
  confirmDoctorId: string,
  patient: Patient,
): Promise<void> {
  await callGateway("update-patient", token, {
    confirmDoctorId,
    patient: {
      id: patient.id,
      cin: patient.cin,
      prenom: patient.prenom,
      nom: patient.nom,
      age: patient.age,
      genre: patient.genre,
      handicap: patient.handicap,
    },
  });
}

async function removeDocuments(
  patientId: string,
  documentIds: string[],
  doctorData: DoctorData,
): Promise<void> {
  const uniqueIds = [...new Set(documentIds)].filter(validUuid);
  if (!uniqueIds.length) return;

  const allowed = doctorData.documents.filter(
    (document) => document.dossier_id === patientId && uniqueIds.includes(document.id),
  );
  if (allowed.length !== uniqueIds.length) {
    throw new HttpError(400, "Un élément du dossier médical est invalide.");
  }

  const { error: metadataError } = await admin
    .from("dossier_medical_document")
    .delete()
    .eq("dossier_id", patientId)
    .in("id", uniqueIds);
  if (metadataError) {
    throw new HttpError(500, "Un élément du dossier médical n'a pas pu être supprimé.");
  }

  const storagePaths = allowed
    .map((document) => document.chemin_stockage)
    .filter((value): value is string => Boolean(value));
  if (storagePaths.length) {
    await ensurePrivateBucket();
    const { error } = await admin.storage.from(BUCKET).remove(storagePaths);
    if (error) {
      // The database is the source of truth for visibility. A failed object
      // cleanup leaves an inaccessible private orphan instead of a broken
      // document entry in the doctor's interface.
      console.error("Private Storage cleanup failed", error.message);
    }
  }
}

async function insertTextEntry(patientId: string, text: string): Promise<string | null> {
  const content = text.trim();
  if (!content) return null;
  if (content.length > 20_000) throw new HttpError(400, "Le texte du dossier médical est trop long.");
  const { data, error } = await admin
    .from("dossier_medical_document")
    .insert({
      dossier_id: patientId,
      nom_fichier: "Note médicale",
      type_mime: "text/plain",
      taille_octets: null,
      chemin_stockage: null,
      statut: "traite",
      contenu: content,
    })
    .select("id")
    .single();
  if (error) throw new HttpError(500, "Le texte du dossier médical n'a pas pu être enregistré.");
  return String(data.id);
}

async function uploadFiles(patientId: string, files: File[]): Promise<string[]> {
  if (!files.length) return [];
  await ensurePrivateBucket();
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new HttpError(413, "La sélection dépasse la limite totale de 100 Mo.");
  }

  const uploadedPaths: string[] = [];
  try {
    for (const file of files) {
      if (!file.size) throw new HttpError(400, `Le fichier ${safeOriginalName(file.name)} est vide.`);
      if (file.size > MAX_FILE_BYTES) {
        throw new HttpError(413, `${safeOriginalName(file.name)} dépasse la limite de 25 Mo.`);
      }

      const originalName = safeOriginalName(file.name);
      const storagePath = `${patientId}/${crypto.randomUUID()}${storageExtension(originalName)}`;
      const { error: uploadError } = await admin.storage.from(BUCKET).upload(storagePath, file, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
        cacheControl: "3600",
      });
      if (uploadError) throw new HttpError(500, `Le fichier ${originalName} n'a pas pu être enregistré.`);
      uploadedPaths.push(storagePath);

      const { error: metadataError } = await admin.from("dossier_medical_document").insert({
        dossier_id: patientId,
        nom_fichier: originalName,
        type_mime: file.type || "application/octet-stream",
        taille_octets: file.size,
        chemin_stockage: storagePath,
        statut: "traite",
        contenu: null,
      });
      if (metadataError) {
        await admin.storage.from(BUCKET).remove([storagePath]);
        uploadedPaths.pop();
        throw new HttpError(500, `Les informations du fichier ${originalName} n'ont pas pu être enregistrées.`);
      }
    }
    return uploadedPaths;
  } catch (error) {
    if (uploadedPaths.length) {
      await admin.storage.from(BUCKET).remove(uploadedPaths);
      await admin
        .from("dossier_medical_document")
        .delete()
        .in("chemin_stockage", uploadedPaths);
    }
    throw error;
  }
}

function formFiles(form: FormData): File[] {
  return form
    .getAll("files")
    .filter((value): value is File => value instanceof File && value.size > 0);
}

async function rollbackAdditions(
  uploadedPaths: string[],
  textEntryId: string | null,
): Promise<void> {
  if (uploadedPaths.length) {
    await ensurePrivateBucket();
    const { error: storageError } = await admin.storage.from(BUCKET).remove(uploadedPaths);
    if (storageError) console.error("Storage rollback failed", storageError.message);
    const { error: metadataError } = await admin
      .from("dossier_medical_document")
      .delete()
      .in("chemin_stockage", uploadedPaths);
    if (metadataError) console.error("File metadata rollback failed", metadataError.message);
  }
  if (textEntryId) {
    const { error } = await admin
      .from("dossier_medical_document")
      .delete()
      .eq("id", textEntryId);
    if (error) console.error("Text-entry rollback failed", error.message);
  }
}

async function savePatient(request: Request, form: FormData): Promise<Response> {
  const token = requiredHeader(request, "x-msob-session");
  const confirmDoctorId = requiredHeader(request, "x-msob-confirm-id").toLowerCase();
  const mode = String(form.get("mode") || "");
  let patient: Patient;
  try {
    patient = JSON.parse(String(form.get("patient") || "{}")) as Patient;
  } catch {
    throw new HttpError(400, "Informations patient invalides.");
  }
  const folderText = String(form.get("folder_text") || "");
  let removedDocumentIds: string[] = [];
  try {
    const parsed = JSON.parse(String(form.get("removed_document_ids") || "[]"));
    removedDocumentIds = Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    throw new HttpError(400, "Liste de suppression invalide.");
  }
  const files = formFiles(form);

  let patientId = String(patient.id || "");
  let createdPatient = false;
  let originalPatient: Patient | null = null;
  if (mode === "create") {
    const createPatient = { ...patient } as Partial<Patient>;
    delete createPatient.id;
    const result = await callGateway("create-patient", token, {
      confirmDoctorId,
      patient: createPatient,
    });
    patientId = String(result.patient_id || result.id || "");
    if (!validUuid(patientId)) {
      const data = await loadDoctorData(token);
      const created = data.patients.find((item) => normalizeCin(item.cin) === normalizeCin(patient.cin));
      patientId = created?.id || "";
    }
    createdPatient = validUuid(patientId);
  } else if (mode === "update") {
    if (!validUuid(patientId)) throw new HttpError(400, "Dossier patient invalide.");
    const beforeUpdate = await loadDoctorData(token);
    originalPatient = findPatient(beforeUpdate, patientId);
    await callGateway("update-patient", token, {
      confirmDoctorId,
      patient,
    });
  } else {
    throw new HttpError(400, "Mode d'enregistrement invalide.");
  }

  if (!validUuid(patientId)) {
    throw new HttpError(500, "Le dossier patient a été enregistré, mais son identifiant n'a pas été retrouvé.");
  }

  const dataAfterProfile = await loadDoctorData(token);
  findPatient(dataAfterProfile, patientId);
  let uploaded: string[] = [];
  let textEntryId: string | null = null;
  try {
    uploaded = await uploadFiles(patientId, files);
    textEntryId = await insertTextEntry(patientId, folderText);
    await removeDocuments(patientId, removedDocumentIds, dataAfterProfile);
  } catch (error) {
    await rollbackAdditions(uploaded, textEntryId);
    if (createdPatient) {
      const { error: rollbackError } = await admin
        .from("dossier_medical_patient")
        .delete()
        .eq("id", patientId);
      if (rollbackError) console.error("Created-patient rollback failed", rollbackError.message);
    } else if (originalPatient) {
      try {
        await callGateway("update-patient", token, {
          confirmDoctorId,
          patient: originalPatient,
        });
      } catch (rollbackError) {
        console.error(
          "Patient-profile rollback failed",
          rollbackError instanceof Error ? rollbackError.message : "unknown error",
        );
      }
    }
    throw error;
  }

  const savedPatient = findPatient(dataAfterProfile, patientId);
  await recordActivity(
    token,
    mode === "create" ? "patient.created" : "patient.updated",
    "patient",
    patientId,
    patientAuditLabel(savedPatient),
    { source: "doctor" },
  );
  if (uploaded.length || textEntryId || removedDocumentIds.length) {
    await recordActivity(
      token,
      mode === "create" ? "medical_folder.added" : "medical_folder.updated",
      "medical_folder",
      patientId,
      patientAuditLabel(savedPatient),
      {
        files_added: uploaded.length,
        text_added: Boolean(textEntryId),
        entries_removed: removedDocumentIds.length,
      },
    );
  }

  return json(request, {
    status: "saved",
    patient_id: patientId,
    uploaded_files: uploaded.length,
    removed_entries: removedDocumentIds.length,
    text_added: Boolean(folderText.trim()),
  });
}

async function adminPatientData(request: Request): Promise<Response> {
  const token = requiredHeader(request, "x-msob-session");
  const data = await loadAdminPatientData(token);
  return json(request, data);
}

async function saveAdminPatient(request: Request, form: FormData): Promise<Response> {
  const token = requiredHeader(request, "x-msob-session");
  const confirmAdminId = requiredHeader(request, "x-msob-confirm-id").toLowerCase();
  const mode = String(form.get("mode") || "");
  if (!new Set(["create", "update"]).has(mode)) {
    throw new HttpError(400, "Mode d'enregistrement administrateur invalide.");
  }

  let patient: Patient;
  try {
    patient = JSON.parse(String(form.get("patient") || "{}")) as Patient;
  } catch {
    throw new HttpError(400, "Informations patient invalides.");
  }
  if (mode === "update" && !validUuid(String(patient.id || ""))) {
    throw new HttpError(400, "Dossier patient invalide.");
  }

  const folderText = String(form.get("folder_text") || "");
  let removedDocumentIds: string[] = [];
  try {
    const parsed = JSON.parse(String(form.get("removed_document_ids") || "[]"));
    removedDocumentIds = Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    throw new HttpError(400, "Liste de suppression invalide.");
  }
  const files = formFiles(form);

  let patientId = String(patient.id || "");
  let createdPatient = false;
  let originalPatient: Patient | null = null;
  if (mode === "create") {
    const createPatient = { ...patient } as Partial<Patient>;
    delete createPatient.id;
    patientId = await createPatientAsAdmin(token, confirmAdminId, createPatient);
    createdPatient = true;
  } else {
    const beforeUpdate = await loadAdminPatientData(token);
    originalPatient = findPatient(beforeUpdate, patientId);
    await callAdminPatientGateway("update-patient", token, {
      confirmAdminId,
      patient,
    });
  }

  const dataAfterProfile = await loadAdminPatientData(token);
  const savedPatient = findPatient(dataAfterProfile, patientId);
  let uploaded: string[] = [];
  let textEntryId: string | null = null;
  try {
    uploaded = await uploadFiles(patientId, files);
    textEntryId = await insertTextEntry(patientId, folderText);
    await removeDocuments(patientId, removedDocumentIds, dataAfterProfile);
  } catch (error) {
    await rollbackAdditions(uploaded, textEntryId);
    if (createdPatient) {
      const { error: rollbackError } = await admin
        .from("dossier_medical_patient")
        .delete()
        .eq("id", patientId);
      if (rollbackError) console.error("Admin-created patient rollback failed", rollbackError.message);
    } else if (originalPatient) {
      try {
        await callAdminPatientGateway("update-patient", token, {
          confirmAdminId,
          patient: originalPatient,
        });
      } catch (rollbackError) {
        console.error(
          "Admin patient-profile rollback failed",
          rollbackError instanceof Error ? rollbackError.message : "unknown error",
        );
      }
    }
    throw error;
  }

  await recordActivity(
    token,
    mode === "create" ? "patient.created" : "patient.updated",
    "patient",
    patientId,
    patientAuditLabel(savedPatient),
    { source: "administration" },
  );
  if (uploaded.length || textEntryId || removedDocumentIds.length) {
    await recordActivity(
      token,
      mode === "create" ? "medical_folder.added" : "medical_folder.updated",
      "medical_folder",
      patientId,
      patientAuditLabel(savedPatient),
      {
        files_added: uploaded.length,
        text_added: Boolean(textEntryId),
        entries_removed: removedDocumentIds.length,
      },
    );
  }

  return json(request, {
    status: "saved",
    patient_id: patientId,
    uploaded_files: uploaded.length,
    removed_entries: removedDocumentIds.length,
    text_added: Boolean(folderText.trim()),
  });
}

async function listPatientStoragePaths(patientId: string): Promise<string[]> {
  try {
    await ensurePrivateBucket();
    const { data, error } = await admin.storage.from(BUCKET).list(patientId, {
      limit: 1000,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) {
      console.error("Patient Storage listing failed", error.message);
      return [];
    }
    return (data || [])
      .filter((item) => item.name && item.id)
      .map((item) => `${patientId}/${item.name}`);
  } catch (error) {
    console.error(
      "Patient Storage listing failed",
      error instanceof Error ? error.message : "unknown error",
    );
    return [];
  }
}

async function removeStoragePaths(paths: string[]): Promise<boolean> {
  const uniquePaths = [...new Set(paths.filter(Boolean))];
  if (!uniquePaths.length) return false;
  await ensurePrivateBucket();
  let lastError: { message?: string } | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { error } = await admin.storage.from(BUCKET).remove(uniquePaths);
    if (!error) return false;
    lastError = error;
  }
  console.error("Deleted-patient Storage cleanup failed", lastError?.message || "unknown error");
  return true;
}

async function deletePatient(request: Request, form: FormData): Promise<Response> {
  const token = requiredHeader(request, "x-msob-session");
  const confirmAdminId = requiredHeader(request, "x-msob-confirm-id").toLowerCase();
  const patientId = String(form.get("patient_id") || "");
  const patientFullName = String(form.get("patient_full_name") || "").trim();
  if (!validUuid(patientId)) throw new HttpError(400, "Dossier patient invalide.");

  const data = await loadAdminPatientData(token);
  const patient = findPatient(data, patientId);
  const expectedFullName = `${patient.prenom} ${patient.nom}`;
  if (patientFullName !== expectedFullName) {
    throw new HttpError(400, "Nom complet du patient incorrect.");
  }

  const metadataPaths = data.documents
    .filter((document) => document.dossier_id === patientId)
    .map((document) => document.chemin_stockage)
    .filter((value): value is string => Boolean(value));
  const listedPaths = await listPatientStoragePaths(patientId);
  const result = await callAdminPatientGateway("delete-patient", token, {
    confirmAdminId,
    patientId,
    patientFullName,
  });
  const returnedPaths = Array.isArray(result.storage_paths)
    ? result.storage_paths.map(String)
    : [];
  const storageCleanupWarning = await removeStoragePaths([
    ...metadataPaths,
    ...listedPaths,
    ...returnedPaths,
  ]);
  await recordActivity(
    token,
    "patient.deleted",
    "patient",
    patientId,
    patientAuditLabel(patient),
    {
      files_removed: new Set([...metadataPaths, ...listedPaths, ...returnedPaths]).size,
      storage_cleanup_warning: storageCleanupWarning,
    },
  );

  return json(request, {
    status: "deleted",
    patient_id: patientId,
    storage_cleanup_warning: storageCleanupWarning,
  });
}

async function addToFolder(request: Request, form: FormData): Promise<Response> {
  const token = requiredHeader(request, "x-msob-session");
  const confirmDoctorId = requiredHeader(request, "x-msob-confirm-id").toLowerCase();
  const patientId = String(form.get("dossier_id") || "");
  if (!validUuid(patientId)) throw new HttpError(400, "Dossier patient invalide.");
  const folderText = String(form.get("folder_text") || "");
  const files = formFiles(form);
  if (!folderText.trim() && !files.length) throw new HttpError(400, "Aucun élément à enregistrer.");

  const doctorData = await loadDoctorData(token);
  const patient = findPatient(doctorData, patientId);
  await validateDoctorConfirmation(token, confirmDoctorId, patient);
  let uploaded: string[] = [];
  let textEntryId: string | null = null;
  try {
    uploaded = await uploadFiles(patientId, files);
    textEntryId = await insertTextEntry(patientId, folderText);
  } catch (error) {
    await rollbackAdditions(uploaded, textEntryId);
    throw error;
  }

  await recordActivity(
    token,
    "medical_folder.added",
    "medical_folder",
    patientId,
    patientAuditLabel(patient),
    { files_added: uploaded.length, text_added: Boolean(textEntryId) },
  );

  return json(request, {
    status: "saved",
    patient_id: patientId,
    uploaded_files: uploaded.length,
    text_added: Boolean(folderText.trim()),
  });
}

async function saveReport(request: Request, form: FormData): Promise<Response> {
  const token = requiredHeader(request, "x-msob-session");
  const confirmDoctorId = requiredHeader(request, "x-msob-confirm-id").toLowerCase();
  const patientId = String(form.get("dossier_id") || "");
  const reportText = String(form.get("report_text") || "").trim();
  if (!validUuid(patientId)) throw new HttpError(400, "Dossier patient invalide.");
  if (!reportText) throw new HttpError(400, "Rapport requis.");

  const doctorData = await loadDoctorData(token);
  const patient = findPatient(doctorData, patientId);
  await callGateway("save-report", token, {
    confirmDoctorId,
    dossierId: patientId,
    reportText,
  });
  await recordActivity(
    token,
    "report.confirmed",
    "report",
    patientId,
    patientAuditLabel(patient),
    {},
  );
  return json(request, { status: "saved", patient_id: patientId });
}

async function recordAnalysisLaunch(request: Request, form: FormData): Promise<Response> {
  const token = requiredHeader(request, "x-msob-session");
  const patientId = String(form.get("dossier_id") || "");
  const requestId = String(form.get("request_id") || "");
  const retry = String(form.get("retry") || "false") === "true";
  if (!validUuid(patientId) || !validUuid(requestId)) {
    throw new HttpError(400, "Référence d'analyse invalide.");
  }
  const doctorData = await loadDoctorData(token);
  const patient = findPatient(doctorData, patientId);
  await recordActivity(
    token,
    retry ? "analysis.retried" : "analysis.launched",
    "analysis",
    requestId,
    patientAuditLabel(patient),
    { patient_id: patientId },
  );
  return json(request, { status: "recorded", request_id: requestId });
}

async function adminLogs(request: Request): Promise<Response> {
  const token = requiredHeader(request, "x-msob-session");
  const { data, error } = await admin.rpc("msob_list_activity", {
    p_token: token,
    p_limit: 300,
  });
  if (error) throw new HttpError(400, error.message || "Le journal n'a pas pu être chargé.");
  return json(request, data || { logs: [] });
}

async function manageDoctor(request: Request, form: FormData): Promise<Response> {
  const token = requiredHeader(request, "x-msob-session");
  const confirmAdminId = requiredHeader(request, "x-msob-confirm-id").toLowerCase();
  const operation = String(form.get("operation") || "");
  const before = await callGateway("list-doctors", token);
  const doctors = Array.isArray(before.doctors) ? before.doctors as Record<string, unknown>[] : [];

  if (operation === "admin-save-doctor") {
    let doctor: Record<string, unknown>;
    try {
      doctor = JSON.parse(String(form.get("doctor") || "{}")) as Record<string, unknown>;
    } catch {
      throw new HttpError(400, "Informations médecin invalides.");
    }
    const updating = validUuid(String(doctor.id || ""));
    await callGateway("save-doctor", token, { confirmAdminId, doctor });
    const after = await callGateway("list-doctors", token);
    const updatedDoctors = Array.isArray(after.doctors) ? after.doctors as Record<string, unknown>[] : [];
    const saved = updatedDoctors.find((item) => (
      updating
        ? String(item.id) === String(doctor.id)
        : String(item.doctor_id) === String(doctor.doctor_id).toLowerCase()
    ));
    if (!saved) throw new HttpError(500, "Le médecin enregistré n'a pas été retrouvé.");
    await recordActivity(
      token,
      updating ? "doctor.updated" : "doctor.created",
      "doctor",
      String(saved.id || ""),
      doctorAuditLabel(saved),
      {},
    );
    return json(request, { status: "saved", doctor: saved });
  }

  if (operation === "admin-delete-doctor") {
    const doctorId = String(form.get("doctor_id") || "");
    const target = doctors.find((doctor) => String(doctor.id) === doctorId);
    if (!target) throw new HttpError(404, "Médecin introuvable.");
    await callGateway("delete-doctor", token, { confirmAdminId, doctorId });
    await recordActivity(
      token,
      "doctor.deleted",
      "doctor",
      doctorId,
      doctorAuditLabel(target),
      {},
    );
    return json(request, { status: "deleted", doctor_id: doctorId });
  }

  throw new HttpError(400, "Opération médecin invalide.");
}

async function downloadFile(request: Request): Promise<Response> {
  const token = requiredHeader(request, "x-msob-session");
  const documentId = new URL(request.url).searchParams.get("document_id") || "";
  if (!validUuid(documentId)) throw new HttpError(400, "Document invalide.");

  const accessibleData = await loadAccessibleData(token);
  const document = accessibleData.documents.find((item) => item.id === documentId);
  if (!document?.chemin_stockage) throw new HttpError(404, "Fichier introuvable.");

  await ensurePrivateBucket();
  const { data, error } = await admin.storage.from(BUCKET).download(document.chemin_stockage);
  if (error || !data) throw new HttpError(404, "Fichier introuvable.");
  const filename = safeOriginalName(document.nom_fichier || "document");
  return new Response(data, {
    status: 200,
    headers: {
      ...corsHeaders(request),
      "Content-Type": document.type_mime || data.type || "application/octet-stream",
      "Content-Length": String(document.taille_octets || data.size),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
  try {
    if (request.method === "GET") return await downloadFile(request);
    if (request.method !== "POST") throw new HttpError(405, "Méthode non autorisée.");

    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      throw new HttpError(415, "Le formulaire de fichier est invalide.");
    }
    const form = await request.formData();
    const operation = String(form.get("operation") || "");
    if (operation === "save-patient") return await savePatient(request, form);
    if (operation === "add-folder") return await addToFolder(request, form);
    if (operation === "save-report") return await saveReport(request, form);
    if (operation === "record-analysis") return await recordAnalysisLaunch(request, form);
    if (operation === "admin-data") return await adminPatientData(request);
    if (operation === "admin-logs") return await adminLogs(request);
    if (operation === "admin-save-patient") return await saveAdminPatient(request, form);
    if (operation === "admin-save-doctor" || operation === "admin-delete-doctor") {
      return await manageDoctor(request, form);
    }
    if (operation === "delete-patient") return await deletePatient(request, form);
    throw new HttpError(400, "Opération inconnue.");
  } catch (error) {
    if (error instanceof HttpError) return json(request, { error: error.message }, error.status);
    console.error("msob-medical-files failed", error instanceof Error ? error.message : "unknown error");
    return json(request, { error: "Le service de fichiers n'a pas pu traiter la demande." }, 500);
  }
});
