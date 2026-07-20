"use strict";

const CONFIG = Object.freeze({
  gatewayUrl: "https://inqnyoqqhtogrvgjyavo.supabase.co/rest/v1/rpc/msob_gateway",
  fileFunctionUrl: "https://inqnyoqqhtogrvgjyavo.supabase.co/functions/v1/msob-medical-files",
  publishableKey: "sb_publishable_m45iFH-I3oUdBtz8Bl0_-g_DemQoMoH",
  productionWebhookFile: "PRODUCTION_WEBHOOK.txt",
  testWebhookUrl: "https://stg-agentic.abafusion.ai/api/v1/webhook/fc3a3d9d-43d9-4b2a-b6b7-5704af3814a2",
  mcpUploadUrl: "http://127.0.0.1:8002/upload",
  mcpQueueUrl: "http://127.0.0.1:8002/queue",
  testMailboxUrl: "https://ntfy.sh/inqnyoqqhtogrvgjyavo/json?poll=1",
  doctorSessionKey: "msob_doctor_session_v2",
  legacyClinicalRequestKey: "msob_active_clinical_request_v1",
  doctorIdleMs: 30 * 60 * 1000,
  mascotCountdownDelayMs: 60 * 1000,
  clinicalPollIntervalMs: 3_000,
  clinicalReturnTimeoutMs: 30 * 60 * 1000,
  maxStoredFileBytes: 25 * 1024 * 1024,
});

const GENDERS = [
  "Féminin",
  "Masculin",
  "Non binaire",
  "Intersexe",
  "Genre fluide",
  "Agenre",
  "Bispirituel·le",
  "Ne souhaite pas préciser",
  "Autre",
];

const state = {
  role: null,
  token: null,
  actor: null,
  patients: [],
  reports: [],
  documents: [],
  selectedPatientId: null,
  selectedHistoryReportId: null,
  pendingRole: null,
  pendingReportRaw: null,
  pendingReportPatientId: null,
  analysisDraft: null,
  analysisLocked: false,
  analysisProcessing: false,
  activeClinicalRequest: null,
  clinicalPollTimer: null,
  clinicalProgressTimer: null,
  clinicalMonitorGeneration: 0,
  caseFiles: [],
  patientFiles: [],
  folderFiles: [],
  editingPatient: null,
  patientDraft: null,
  removedDocumentIds: new Set(),
  editingDoctor: null,
  adminDoctors: [],
  adminLogs: [],
  adminActiveTab: "doctors",
  patientEditorRole: "doctor",
  deletePatientTarget: null,
  confirmAction: null,
  confirmCancel: null,
  doctorLastActivity: 0,
  doctorLastServerTouch: 0,
  testStartedAt: Date.now(),
};

const $ = (id) => document.getElementById(id);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const show = (id) => $(id)?.classList.remove("hidden");
const hide = (id) => $(id)?.classList.add("hidden");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function normalizeFirst(value) {
  const words = String(value ?? "")
    .trim()
    .toLocaleLowerCase("fr-FR")
    .split(/\s+/)
    .filter(Boolean);
  return words
    .map((word) => word.charAt(0).toLocaleUpperCase("fr-FR") + word.slice(1))
    .join(" ");
}

function normalizeLast(value) {
  return String(value ?? "").trim().toLocaleUpperCase("fr-FR");
}

function normalizeCin(value) {
  return String(value ?? "").replace(/\s+/g, "").toLocaleUpperCase("fr-FR");
}

function validAccessId(value) {
  return /^(?=.*[a-z])(?=.*\d)[a-z\d]{8,10}$/i.test(String(value ?? ""));
}

function validMoroccanCin(value) {
  return /^[A-Z]{1,2}\d{5,6}$/.test(normalizeCin(value));
}

function formatDate(value, options = {}) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    ...options,
  }).format(date);
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function formatReportDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function reportFileTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "date-inconnue";
  const parts = new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}_${byType.hour}h${byType.minute}`;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return "";
  const units = ["o", "Ko", "Mo", "Go"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const amount = bytes / (1024 ** exponent);
  return `${amount.toLocaleString("fr-FR", { maximumFractionDigits: exponent ? 1 : 0 })} ${units[exponent]}`;
}

function friendlyError(error) {
  const raw = error instanceof Error ? error.message : String(error || "");
  if (/duplicate|unique|cin.*exist|already exists/i.test(raw)) {
    return "Un dossier avec ce CIN existe déjà.";
  }
  if (
    /confirm.*admin|admin.*(id|identifier)|administrateur.*(id|identifiant)|(id|identifiant).*administrateur|administrateur.*diff[ée]rent|wrong admin/i.test(raw)
  ) {
    return "ID administrateur incorrect. Saisissez l'ID de l'administrateur connecté.";
  }
  if (
    /confirm.*doctor|doctor.*(id|identifier)|m[ée]decin.*(id|identifiant)|(id|identifiant).*m[ée]decin|m[ée]decin.*diff[ée]rent|wrong doctor/i.test(raw)
  ) {
    return "ID médecin incorrect. Saisissez l'ID du médecin connecté.";
  }
  if (/invalid.*(login|credential)|unknown.*(doctor|admin)|not found.*(doctor|admin)/i.test(raw)) {
    return "Identifiant non reconnu.";
  }
  if (/session|token|unauthori[sz]ed|forbidden|expired|autorisation/i.test(raw)) {
    return "Votre session a expiré. Reconnectez-vous.";
  }
  if (/failed to fetch|networkerror|network request|connexion/i.test(raw)) {
    return "Le service est momentanément inaccessible. Réessayez.";
  }
  return raw || "La demande n'a pas pu être traitée.";
}

function toast(message, tone = "success") {
  const item = document.createElement("div");
  item.className = `toast ${tone}`;
  item.textContent = message;
  $("toast-region").append(item);
  requestAnimationFrame(() => item.classList.add("visible"));
  setTimeout(() => {
    item.classList.remove("visible");
    setTimeout(() => item.remove(), 250);
  }, 4200);
}

function setError(id, message = "") {
  const element = $(id);
  if (!element) return;
  element.textContent = message;
  element.classList.toggle("hidden", !message);
}

function setButtonBusy(button, busy, busyLabel = "Traitement…") {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = busyLabel;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
    delete button.dataset.label;
  }
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

async function gateway(action, payload = {}, token = state.token) {
  const response = await fetch(CONFIG.gatewayUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: CONFIG.publishableKey,
      Authorization: `Bearer ${CONFIG.publishableKey}`,
    },
    body: JSON.stringify({
      p_action: action,
      p_token: token || null,
      p_payload: payload,
    }),
  });
  const data = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(data.message || data.error || data.details || `Erreur ${response.status}`);
  }
  return data;
}

function fileHeaders(confirmDoctorId = "") {
  const headers = {
    apikey: CONFIG.publishableKey,
    Authorization: `Bearer ${CONFIG.publishableKey}`,
    "x-msob-session": state.token || "",
  };
  if (confirmDoctorId) headers["x-msob-confirm-id"] = confirmDoctorId;
  return headers;
}

async function savePatientBundle({
  operation = "save-patient",
  mode,
  patient,
  folderText,
  files,
  removedDocumentIds,
  confirmAccessId,
}) {
  const form = new FormData();
  form.append("operation", operation);
  form.append("mode", mode);
  form.append("patient", JSON.stringify(patient));
  form.append("folder_text", folderText || "");
  form.append("removed_document_ids", JSON.stringify(removedDocumentIds || []));
  for (const file of files) form.append("files", file, file.name);

  const response = await fetch(CONFIG.fileFunctionUrl, {
    method: "POST",
    headers: fileHeaders(confirmAccessId),
    body: form,
  });
  const data = await parseJsonResponse(response);
  if (!response.ok) throw new Error(data.message || data.error || `Erreur ${response.status}`);
  return data;
}

async function fetchAdminPatientData() {
  const form = new FormData();
  form.append("operation", "admin-data");
  const response = await fetch(CONFIG.fileFunctionUrl, {
    method: "POST",
    headers: fileHeaders(),
    body: form,
  });
  const data = await parseJsonResponse(response);
  if (!response.ok) throw new Error(data.message || data.error || `Erreur ${response.status}`);
  return data;
}

async function deletePatientBundle({ patientId, patientFullName, confirmAdminId }) {
  const form = new FormData();
  form.append("operation", "delete-patient");
  form.append("patient_id", patientId);
  form.append("patient_full_name", patientFullName);
  const response = await fetch(CONFIG.fileFunctionUrl, {
    method: "POST",
    headers: fileHeaders(confirmAdminId),
    body: form,
  });
  const data = await parseJsonResponse(response);
  if (!response.ok) throw new Error(data.message || data.error || `Erreur ${response.status}`);
  return data;
}

async function addMedicalFolderBundle({ dossierId, text, files, confirmDoctorId }) {
  const form = new FormData();
  form.append("operation", "add-folder");
  form.append("dossier_id", dossierId);
  form.append("folder_text", text || "");
  for (const file of files) form.append("files", file, file.name);

  const response = await fetch(CONFIG.fileFunctionUrl, {
    method: "POST",
    headers: fileHeaders(confirmDoctorId),
    body: form,
  });
  const data = await parseJsonResponse(response);
  if (!response.ok) throw new Error(data.message || data.error || `Erreur ${response.status}`);
  return data;
}

async function saveReportBundle({ dossierId, reportText, confirmDoctorId }) {
  const form = new FormData();
  form.append("operation", "save-report");
  form.append("dossier_id", dossierId);
  form.append("report_text", reportText);
  const response = await fetch(CONFIG.fileFunctionUrl, {
    method: "POST",
    headers: fileHeaders(confirmDoctorId),
    body: form,
  });
  const data = await parseJsonResponse(response);
  if (!response.ok) throw new Error(data.message || data.error || `Erreur ${response.status}`);
  return data;
}

async function recordAnalysisActivity({ dossierId, requestId, retry }) {
  const form = new FormData();
  form.append("operation", "record-analysis");
  form.append("dossier_id", dossierId);
  form.append("request_id", requestId);
  form.append("retry", String(Boolean(retry)));
  const response = await fetch(CONFIG.fileFunctionUrl, {
    method: "POST",
    headers: fileHeaders(),
    body: form,
  });
  const data = await parseJsonResponse(response);
  if (!response.ok) throw new Error(data.message || data.error || `Erreur ${response.status}`);
  return data;
}

async function fetchAdminActivityLogs() {
  const form = new FormData();
  form.append("operation", "admin-logs");
  const response = await fetch(CONFIG.fileFunctionUrl, {
    method: "POST",
    headers: fileHeaders(),
    body: form,
  });
  const data = await parseJsonResponse(response);
  if (!response.ok) throw new Error(data.message || data.error || `Erreur ${response.status}`);
  return Array.isArray(data.logs) ? data.logs : [];
}

async function manageDoctorBundle(operation, confirmAdminId, doctor) {
  const form = new FormData();
  form.append("operation", operation);
  if (operation === "admin-save-doctor") form.append("doctor", JSON.stringify(doctor));
  else form.append("doctor_id", String(doctor.id || doctor));
  const response = await fetch(CONFIG.fileFunctionUrl, {
    method: "POST",
    headers: fileHeaders(confirmAdminId),
    body: form,
  });
  const data = await parseJsonResponse(response);
  if (!response.ok) throw new Error(data.message || data.error || `Erreur ${response.status}`);
  return data;
}

async function downloadMedicalFile(documentRecord) {
  const url = new URL(CONFIG.fileFunctionUrl);
  url.searchParams.set("document_id", documentRecord.id);
  const response = await fetch(url, { headers: fileHeaders() });
  if (!response.ok) {
    const data = await parseJsonResponse(response);
    throw new Error(data.message || data.error || `Erreur ${response.status}`);
  }
  return response.blob();
}

function currentPatient() {
  return state.patients.find((patient) => patient.id === state.selectedPatientId) || null;
}

function documentsForPatient(patientId = state.selectedPatientId) {
  return state.documents
    .filter((documentRecord) => documentRecord.dossier_id === patientId)
    .sort((first, second) => new Date(second.date_ajout || 0) - new Date(first.date_ajout || 0));
}

function reportsForPatient(patientId = state.selectedPatientId) {
  return state.reports
    .filter((report) => report.dossier_id === patientId)
    .sort((first, second) => new Date(second.date_generation) - new Date(first.date_generation));
}

function isStoredFile(documentRecord) {
  return Boolean(documentRecord?.chemin_stockage);
}

function cleanReportForDisplay(value) {
  return String(value || "")
    .replace(/^Date et heure du rapport\s*:[^\n]*\n*/im, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .trim();
}

function icon(name) {
  const paths = {
    cin: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9h4M7 13h6M16 9h1M16 13h1"/>',
    age: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>',
    gender: '<circle cx="10" cy="10" r="5"/><path d="M14 6l6-6M15 1h5v5M10 15v7M6 19h8"/>',
    handicap: '<circle cx="12" cy="4" r="2"/><path d="M5 9h14M12 6v7M8 21l4-8 4 8"/>',
    doctor: '<path d="M6 4v4a5 5 0 0 0 10 0V4"/><path d="M4.5 4h3M14.5 4h3"/><path d="M11 13v2a4 4 0 0 0 8 0v-1"/><circle cx="19" cy="11.5" r="2"/>',
    admin: '<circle cx="9" cy="7" r="3"/><path d="M3 20c0-4 2.5-7 6-7 2 0 3.6.8 4.7 2.1"/><path d="M17 12l4 2v3c0 2.7-1.6 4.4-4 5-2.4-.6-4-2.3-4-5v-3z"/>',
    clinical: '<path d="M6 3h12v18H6z"/><path d="M9 3V1h6v2M12 8v6M9 11h6M9 17h6"/>',
    folder: '<path d="M3 7h7l2 2h9v11H3z"/><path d="M14 12v5M11.5 14.5h5"/>',
    consultations: '<rect x="4" y="4" width="16" height="17" rx="2"/><path d="M9 4V2h6v2M8 9h8M8 13h8M8 17h5"/>',
    activity: '<path d="M2 12h4l2.2-5 3.2 10 2.6-7 2 4h6"/>',
    text: '<path d="M4 4h16M4 9h16M4 14h11M4 19h9"/>',
    file: '<path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
  };
  return `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.file}</svg>`;
}

function renderStaticIcons() {
  $$("[data-icon]").forEach((element) => {
    element.innerHTML = icon(element.dataset.icon);
  });
}

function setAssistantContext(context) {
  document.documentElement.dataset.assistantContext = context;
  window.dispatchEvent(new CustomEvent("msob:assistant-context", { detail: { context } }));
}

function showOnlyArea(areaId) {
  for (const id of ["landing", "doctor-area", "admin-area"]) hide(id);
  show(areaId);
  setAssistantContext(areaId === "doctor-area" ? "doctor" : areaId === "admin-area" ? "admin" : "landing");
}

function showDoctorScreen(screenId) {
  for (const id of ["doctor-home-screen", "patient-screen"]) hide(id);
  show(screenId);
}

function showPatientSection(sectionId) {
  for (const id of ["patient-menu", "case-section", "medical-folder-section", "history-section"]) hide(id);
  show(sectionId);
}

function stopClinicalMonitoringTimers() {
  state.clinicalMonitorGeneration += 1;
  if (state.clinicalPollTimer) clearTimeout(state.clinicalPollTimer);
  if (state.clinicalProgressTimer) clearInterval(state.clinicalProgressTimer);
  state.clinicalPollTimer = null;
  state.clinicalProgressTimer = null;
}

function analysisIsProcessing() {
  return state.analysisProcessing;
}

function analysisIsUnresolved() {
  return Boolean(
    state.analysisProcessing
    || state.analysisLocked
    || state.activeClinicalRequest
    || state.pendingReportRaw,
  );
}

function setClinicalProcessing(processing, { refreshSession = true } = {}) {
  const next = Boolean(processing);
  if (state.analysisProcessing === next) return;
  state.analysisProcessing = next;
  window.dispatchEvent(new CustomEvent("msob:analysis-state", {
    detail: { processing: next },
  }));
  if (refreshSession && state.role === "doctor") {
    // Processing time is not doctor inactivity. Touch immediately when work
    // starts/ends; the regular session tick keeps it alive during long runs.
    state.doctorLastActivity = Date.now();
    persistDoctorSession();
    void markDoctorActivity({ forceServer: true });
  }
}

function applyDoctorAnalysisLock() {
  const doctorArea = $("doctor-area");
  if (!doctorArea) return;
  const locked = state.analysisLocked;
  const reportReady = Boolean(state.pendingReportRaw);
  doctorArea.classList.toggle("analysis-locked", locked);
  doctorArea.setAttribute("aria-busy", locked && !reportReady ? "true" : "false");

  const allowed = reportReady
    ? new Set([$("retry-report"), $("confirm-pending-report")])
    : new Set();
  $$("button, input, textarea, select", doctorArea).forEach((control) => {
    const mayRemainEnabled = allowed.has(control);
    if (locked && !mayRemainEnabled) {
      if (!control.disabled) {
        control.disabled = true;
        control.dataset.analysisLocked = "true";
      }
      return;
    }
    if (control.dataset.analysisLocked === "true") {
      control.disabled = false;
      delete control.dataset.analysisLocked;
    }
  });
}

function setDoctorAnalysisLock(locked) {
  state.analysisLocked = Boolean(locked);
  applyDoctorAnalysisLock();
}

function clearActiveClinicalRequest({ unlock = true } = {}) {
  stopClinicalMonitoringTimers();
  state.activeClinicalRequest = null;
  hide("analysis-waiting");
  $("analysis-progress-fill").style.width = "8%";
  $("analysis-progress-track").setAttribute("aria-valuenow", "8");
  $("analysis-progress-track").setAttribute("aria-valuetext", "Analyse en cours");
  $("analysis-processing-status").textContent = "Transmission du dossier clinique…";
  $("analysis-processing-time").textContent = "00:00";
  if (unlock) setDoctorAnalysisLock(false);
}

function formatElapsedTime(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function simulatedClinicalProgress(elapsedMs) {
  const elapsedSeconds = Math.max(0, elapsedMs / 1000);
  return Math.min(94, 8 + (86 * (1 - Math.exp(-elapsedSeconds / 72))));
}

function clinicalProcessingStatus(elapsedMs) {
  if (elapsedMs < 10_000) return "Transmission du dossier clinique…";
  if (elapsedMs < 50_000) return "Analyse clinique en cours…";
  if (elapsedMs < 110_000) return "Mise en commun des avis…";
  return "Préparation du rapport…";
}

function updateClinicalWaitingUi() {
  const request = state.activeClinicalRequest;
  const isCurrentPatient = request && request.patientId === state.selectedPatientId;
  if (!isCurrentPatient || state.pendingReportRaw) {
    hide("analysis-waiting");
    return;
  }

  const elapsed = Date.now() - request.startedAt;
  const progress = simulatedClinicalProgress(elapsed);
  show("analysis-waiting");
  $("analysis-progress-fill").style.width = `${progress.toFixed(2)}%`;
  $("analysis-progress-track").setAttribute("aria-valuenow", String(Math.round(progress)));
  const status = request.connectionInterrupted
    ? "Connexion momentanément interrompue : nouvelle tentative…"
    : clinicalProcessingStatus(elapsed);
  $("analysis-progress-track").setAttribute("aria-valuetext", status);
  $("analysis-processing-status").textContent = status;
  $("analysis-processing-time").textContent = formatElapsedTime(elapsed);
  $("launch-analysis").disabled = true;
}

function startClinicalMonitoring(request, { scroll = false } = {}) {
  stopClinicalMonitoringTimers();
  state.activeClinicalRequest = {
    requestId: request.requestId,
    patientId: request.patientId,
    startedAt: Number(request.startedAt),
    seenEventIds: new Set(),
    connectionInterrupted: false,
  };
  setClinicalProcessing(true);
  setDoctorAnalysisLock(true);
  updateClinicalWaitingUi();
  state.clinicalProgressTimer = setInterval(updateClinicalWaitingUi, 500);
  const generation = state.clinicalMonitorGeneration;
  void pollActiveClinicalMailbox(generation);
  if (scroll && request.patientId === state.selectedPatientId) {
    setTimeout(() => $("analysis-waiting").scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  }
}

function clearDoctorSession() {
  const hadUnresolvedAnalysis = analysisIsUnresolved();
  localStorage.removeItem(CONFIG.doctorSessionKey);
  setClinicalProcessing(false, { refreshSession: false });
  clearActiveClinicalRequest();
  state.analysisDraft = null;
  state.pendingReportRaw = null;
  state.pendingReportPatientId = null;
  state.caseFiles = [];
  state.doctorLastActivity = 0;
  state.doctorLastServerTouch = 0;
  if (hadUnresolvedAnalysis) void clearAllClinicalQueues().catch(() => {});
}

function persistDoctorSession() {
  if (state.role !== "doctor" || !state.token || !state.actor) return;
  localStorage.setItem(CONFIG.doctorSessionKey, JSON.stringify({
    token: state.token,
    actor: state.actor,
    lastActivity: state.doctorLastActivity,
  }));
}

async function expireDoctorSession(message = "") {
  clearDoctorSession();
  state.role = null;
  state.token = null;
  state.actor = null;
  state.selectedPatientId = null;
  state.patients = [];
  state.reports = [];
  state.documents = [];
  history.replaceState(null, "", location.pathname);
  showOnlyArea("landing");
  if (message) toast(message, "warning");
}

async function markDoctorActivity({ forceServer = false } = {}) {
  if (state.role !== "doctor") return;
  const now = Date.now();
  if (
    !analysisIsProcessing()
    && state.doctorLastActivity
    && now - state.doctorLastActivity >= CONFIG.doctorIdleMs
  ) {
    await expireDoctorSession("Votre session a expiré après 30 minutes d'inactivité.");
    return;
  }
  state.doctorLastActivity = now;
  persistDoctorSession();
  if (!forceServer && now - state.doctorLastServerTouch < 60_000) return;
  state.doctorLastServerTouch = now;
  try {
    await gateway("touch-session");
  } catch (error) {
    state.doctorLastServerTouch = 0;
    if (/session|expired|unauthor/i.test(String(error?.message))) {
      await expireDoctorSession("Votre session a expiré.");
    }
  }
}

window.MSOBSession = {
  get role() {
    return state.role;
  },
  get lastActivity() {
    return state.doctorLastActivity;
  },
  get idleLimitMs() {
    return CONFIG.doctorIdleMs;
  },
  get countdownDelayMs() {
    return CONFIG.mascotCountdownDelayMs;
  },
  get analysisInProgress() {
    return state.role === "doctor" && analysisIsProcessing();
  },
  markActivity() {
    void markDoctorActivity();
  },
};

async function restoreDoctorSession() {
  const raw = localStorage.getItem(CONFIG.doctorSessionKey);
  if (!raw) return false;
  try {
    const saved = JSON.parse(raw);
    const lastActivity = Number(saved.lastActivity || 0);
    if (!saved.token || !saved.actor || Date.now() - lastActivity >= CONFIG.doctorIdleMs) {
      throw new Error("expired");
    }
    state.role = "doctor";
    state.token = saved.token;
    state.actor = saved.actor;
    state.doctorLastActivity = Date.now();
    persistDoctorSession();
    await gateway("touch-session");
    state.doctorLastServerTouch = Date.now();
    await loadDoctorData();
    return true;
  } catch {
    clearDoctorSession();
    state.role = null;
    state.token = null;
    state.actor = null;
    return false;
  }
}

function openUnlock(role) {
  state.pendingRole = role;
  setAssistantContext(role === "doctor" ? "doctor-login" : "admin-login");
  $("unlock-title").textContent = role === "doctor" ? "Accès médecin" : "Accès administration";
  $("unlock-id").value = "";
  setError("unlock-error");
  show("unlock-modal");
  setTimeout(() => $("unlock-id").focus(), 0);
}

async function submitUnlock(event) {
  event.preventDefault();
  const id = $("unlock-id").value.trim().toLowerCase();
  if (!validAccessId(id)) {
    setError("unlock-error", "L'ID doit contenir 8 à 10 lettres et chiffres, avec au moins une lettre et un chiffre.");
    return;
  }
  const button = event.submitter || event.currentTarget.querySelector('[type="submit"]');
  setButtonBusy(button, true, "Vérification…");
  try {
    const data = await gateway("unlock", { role: state.pendingRole, id }, null);
    state.role = data.role;
    state.token = data.sessionToken;
    state.actor = data.actor;
    hide("unlock-modal");
    if (state.role === "doctor") {
      state.doctorLastActivity = Date.now();
      persistDoctorSession();
      await loadDoctorData();
    } else {
      clearDoctorSession();
      await loadAdminData();
    }
  } catch (error) {
    setError("unlock-error", friendlyError(error));
  } finally {
    setButtonBusy(button, false);
  }
}

async function loadDoctorData({ selectPatientId = null, section = null } = {}) {
  const data = await gateway("doctor-data");
  state.patients = Array.isArray(data.patients) ? data.patients : [];
  state.reports = Array.isArray(data.reports) ? data.reports : [];
  state.documents = Array.isArray(data.documents) ? data.documents : [];
  state.role = "doctor";
  $("doctor-name").textContent = `Dr ${state.actor.prenom} ${state.actor.nom}`;
  showOnlyArea("doctor-area");
  history.replaceState(null, "", `${location.pathname}#doctor`);
  renderPatientList();
  if (selectPatientId && state.patients.some((patient) => patient.id === selectPatientId)) {
    selectPatient(selectPatientId);
    if (section) openPatientSection(section);
  } else {
    doctorHome();
  }
}

function doctorHome({ force = false } = {}) {
  if (!force && analysisIsUnresolved()) return;
  state.selectedPatientId = null;
  state.selectedHistoryReportId = null;
  showDoctorScreen("doctor-home-screen");
  renderPatientList();
  history.replaceState(null, "", `${location.pathname}#doctor`);
}

function renderPatientList() {
  const term = $("patient-search").value.trim().toLocaleLowerCase("fr-FR");
  const patients = [...state.patients]
    .sort((first, second) => {
      const firstName = first.prenom.localeCompare(second.prenom, "fr", { sensitivity: "base" });
      return firstName || first.nom.localeCompare(second.nom, "fr", { sensitivity: "base" });
    })
    .filter((patient) => `${patient.prenom} ${patient.nom} ${patient.cin}`.toLocaleLowerCase("fr-FR").includes(term));

  $("patient-list").innerHTML = patients.map((patient) => `
    <li>
      <button type="button" data-patient-id="${patient.id}" class="${patient.id === state.selectedPatientId ? "active" : ""}">
        <span>${escapeHtml(patient.prenom)} ${escapeHtml(patient.nom)}</span>
        <small>${escapeHtml(patient.cin)}</small>
      </button>
    </li>
  `).join("");
  applyDoctorAnalysisLock();
}

function selectPatient(patientId, { force = false } = {}) {
  if (!force && analysisIsUnresolved() && patientId !== state.selectedPatientId) return;
  const patient = state.patients.find((item) => item.id === patientId);
  if (!patient) return;
  state.selectedPatientId = patientId;
  $("patient-name").textContent = `${patient.prenom} ${patient.nom}`;
  const details = [
    ["CIN", "cin", patient.cin],
    ["Âge", "age", `${patient.age} ans`],
    ["Genre", "gender", patient.genre],
    ["Handicap(s)", "handicap", patient.handicap || "Aucun"],
  ];
  $("patient-details").innerHTML = details.map(([label, iconName, value]) => `
    <div>
      <dt>${icon(iconName)}${escapeHtml(label)}</dt>
      <dd>${escapeHtml(value)}</dd>
    </div>
  `).join("");
  showDoctorScreen("patient-screen");
  showPatientSection("patient-menu");
  renderPatientList();
  history.replaceState(null, "", `${location.pathname}#doctor/patient`);
}

function openPatientSection(section) {
  if (!currentPatient()) return;
  showPatientSection(section);
  if (section === "medical-folder-section") renderMedicalFolder();
  if (section === "history-section") renderReportHistory();
  if (section === "case-section") {
    setError("case-error");
    if (state.pendingReportRaw && state.pendingReportPatientId === state.selectedPatientId) {
      $("pending-report-text").textContent = cleanReportForDisplay(state.pendingReportRaw);
      show("pending-report");
    } else {
      hide("pending-report");
    }
    updateClinicalWaitingUi();
  }
}

function documentDisplayName(documentRecord) {
  if (isStoredFile(documentRecord)) return documentRecord.nom_fichier || "Document";
  return documentRecord.nom_fichier && documentRecord.nom_fichier !== "Dossier médical"
    ? documentRecord.nom_fichier
    : "Note médicale";
}

function renderMedicalFolder() {
  const documents = documentsForPatient();
  if (!documents.length) {
    $("medical-folder-list").innerHTML = '<p class="empty-state-line">Aucun élément enregistré.</p>';
    return;
  }
  $("medical-folder-list").innerHTML = documents.map((documentRecord) => {
    if (isStoredFile(documentRecord)) {
      return `
        <article class="document-item file-entry">
          <div class="document-icon">${icon("file")}</div>
          <div>
            <strong>${escapeHtml(documentDisplayName(documentRecord))}</strong>
            <span>${escapeHtml(formatBytes(documentRecord.taille_octets))}${documentRecord.date_ajout ? ` · ${escapeHtml(formatDate(documentRecord.date_ajout))}` : ""}</span>
          </div>
          <button class="outline compact" type="button" data-download-document="${documentRecord.id}">${icon("download")}Télécharger</button>
        </article>
      `;
    }
    return `
      <article class="document-item text-entry">
        <div class="document-icon">${icon("text")}</div>
        <div>
          <strong>${escapeHtml(documentDisplayName(documentRecord))}</strong>
          <p>${escapeHtml(documentRecord.contenu || "")}</p>
          ${documentRecord.date_ajout ? `<span>${escapeHtml(formatDate(documentRecord.date_ajout))}</span>` : ""}
        </div>
      </article>
    `;
  }).join("");
}

async function handleDocumentDownload(documentId, button) {
  const documentRecord = state.documents.find((item) => item.id === documentId);
  if (!documentRecord || !isStoredFile(documentRecord)) return;
  setButtonBusy(button, true, "Téléchargement…");
  try {
    const blob = await downloadMedicalFile(documentRecord);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = documentRecord.nom_fichier || "document";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    toast(friendlyError(error), "error");
  } finally {
    setButtonBusy(button, false);
  }
}

function renderReportHistory(reportId = null) {
  const reports = reportsForPatient();
  const selected = reports.find((report) => report.id === reportId)
    || reports.find((report) => report.id === state.selectedHistoryReportId)
    || reports[0]
    || null;
  state.selectedHistoryReportId = selected?.id || null;

  $("history-report-list").innerHTML = reports.length
    ? reports.map((report) => `
      <button type="button" data-history-report="${report.id}" class="${report.id === selected?.id ? "active" : ""}">
        <strong>Consultation</strong>
        <span>${escapeHtml(formatReportDateTime(report.date_generation))}</span>
      </button>
    `).join("")
    : '<p class="empty-state-line">Aucun rapport enregistré.</p>';

  $("history-report-date").textContent = selected
    ? `Rapport du ${formatReportDateTime(selected.date_generation)}`
    : "Aucun rapport";
  $("history-report-text").textContent = selected
    ? cleanReportForDisplay(selected.rapport_text)
    : "Aucun rapport enregistré pour ce dossier.";
  $("download-report").classList.toggle("hidden", !selected);
}

function downloadSelectedReportPdf() {
  const patient = currentPatient();
  const report = reportsForPatient().find((item) => item.id === state.selectedHistoryReportId);
  if (!patient || !report) return;
  const JsPdf = window.jspdf?.jsPDF;
  if (!JsPdf) {
    toast("Le générateur PDF n'est pas disponible.", "error");
    return;
  }

  const pdf = new JsPdf({ unit: "mm", format: "a4" });
  const margin = 18;
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  let y = 22;

  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(18);
  pdf.setTextColor(16, 35, 63);
  pdf.text("Rapport de consultation", margin, y);
  y += 11;
  pdf.setFontSize(11);
  pdf.text(`${patient.prenom} ${patient.nom}`, margin, y);
  y += 6;
  pdf.setFont("helvetica", "normal");
  pdf.setTextColor(80, 98, 120);
  pdf.text(`Date et heure : ${formatReportDateTime(report.date_generation)}`, margin, y);
  y += 12;
  pdf.setDrawColor(210, 225, 237);
  pdf.line(margin, y, pageWidth - margin, y);
  y += 10;
  pdf.setFontSize(11);
  pdf.setTextColor(20, 35, 55);

  const lines = pdf.splitTextToSize(cleanReportForDisplay(report.rapport_text), pageWidth - (margin * 2));
  for (const line of lines) {
    if (y > pageHeight - 18) {
      pdf.addPage();
      y = 20;
    }
    pdf.text(line, margin, y);
    y += 6;
  }

  const safeName = `${patient.prenom}_${patient.nom}`.replace(/[^\p{L}\p{N}_-]+/gu, "_");
  pdf.save(`rapport_${safeName}_${reportFileTimestamp(report.date_generation)}.pdf`);
}

function updateSelectedFiles(kind) {
  const files = state[`${kind}Files`];
  const container = $(`${kind}-selected-files`);
  const status = kind === "case" ? $("case-file-status") : null;
  if (status) status.textContent = files.length ? `${files.length} fichier${files.length > 1 ? "s" : ""}` : "Facultatif";
  container.innerHTML = files.map((file, index) => `
    <span class="selected-file">
      ${icon("file")}
      <span>${escapeHtml(file.name)}${file.size ? ` · ${escapeHtml(formatBytes(file.size))}` : ""}</span>
      <button type="button" data-remove-${kind}-file="${index}" aria-label="Retirer ${escapeHtml(file.name)}">×</button>
    </span>
  `).join("");
}

function appendFiles(kind, incomingFiles) {
  const current = state[`${kind}Files`];
  const seen = new Set(current.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
  for (const file of incomingFiles) {
    if (file.size > CONFIG.maxStoredFileBytes) {
      toast(`${file.name} dépasse la limite de 25 Mo.`, "error");
      continue;
    }
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (!seen.has(key)) {
      current.push(file);
      seen.add(key);
    }
  }
  updateSelectedFiles(kind);
}

function bindDropZone(zoneId, inputId, kind) {
  const zone = $(zoneId);
  const input = $(inputId);
  input.addEventListener("change", () => {
    appendFiles(kind, input.files);
    input.value = "";
  });
  for (const name of ["dragenter", "dragover"]) {
    zone.addEventListener(name, (event) => {
      event.preventDefault();
      zone.classList.add("dragging");
    });
  }
  for (const name of ["dragleave", "drop"]) {
    zone.addEventListener(name, (event) => {
      event.preventDefault();
      zone.classList.remove("dragging");
    });
  }
  zone.addEventListener("drop", (event) => appendFiles(kind, event.dataTransfer.files));
}

function populateGenderSelect(select, selectedValue = "Féminin") {
  select.innerHTML = GENDERS.map((gender) => `
    <option value="${escapeHtml(gender)}" ${gender === selectedValue ? "selected" : ""}>${escapeHtml(gender)}</option>
  `).join("");
}

function openPatientModal(patient = null, { editorRole = state.role === "admin" ? "admin" : "doctor" } = {}) {
  state.patientEditorRole = editorRole;
  state.editingPatient = patient;
  if (patient) state.selectedPatientId = patient.id;
  state.patientDraft = null;
  state.patientFiles = [];
  state.removedDocumentIds = new Set();
  $("patient-form").reset();
  $("patient-modal-title").textContent = patient ? "Modifier les informations du patient" : "Ajouter un dossier patient";
  $("patient-form-step").classList.remove("hidden");
  $("patient-review-step").classList.add("hidden");
  setError("patient-error");
  setError("patient-review-error");

  const form = $("patient-form");
  form.elements.cin.value = patient?.cin || "";
  form.elements.prenom.value = patient?.prenom || "";
  form.elements.nom.value = patient?.nom || "";
  form.elements.age.value = patient?.age ?? "";
  populateGenderSelect(form.elements.genre, patient?.genre || "Féminin");
  form.elements.handicap.value = patient?.handicap || "Aucun";
  $("patient-folder-text").value = "";
  $("patient-folder-text").placeholder = patient
    ? "Ajouter une nouvelle note médicale…"
    : "Informations médicales connues…";
  updateSelectedFiles("patient");
  renderExistingFolderEditor();
  show("patient-modal");
}

function renderExistingFolderEditor() {
  const editor = $("existing-folder-editor");
  const container = $("existing-folder-list");
  if (!state.editingPatient) {
    editor.classList.add("hidden");
    container.innerHTML = "";
    return;
  }
  const documents = documentsForPatient(state.editingPatient.id);
  editor.classList.remove("hidden");
  if (!documents.length) {
    container.innerHTML = '<p class="empty-state-line">Aucun élément enregistré.</p>';
    return;
  }
  container.innerHTML = documents.map((documentRecord) => {
    const removed = state.removedDocumentIds.has(documentRecord.id);
    return `
      <article class="editable-document ${removed ? "marked-for-removal" : ""}">
        <div class="document-icon">${icon(isStoredFile(documentRecord) ? "file" : "text")}</div>
        <div>
          <strong>${escapeHtml(documentDisplayName(documentRecord))}</strong>
          ${isStoredFile(documentRecord)
            ? `<span>${escapeHtml(formatBytes(documentRecord.taille_octets))}</span>`
            : `<p>${escapeHtml(documentRecord.contenu || "")}</p>`}
        </div>
        <div class="editable-document-actions">
          ${isStoredFile(documentRecord) ? `<button class="outline compact" type="button" data-edit-download="${documentRecord.id}">Télécharger</button>` : ""}
          <button class="${removed ? "outline" : "danger-outline"} compact" type="button" data-toggle-remove-document="${documentRecord.id}">
            ${removed ? "Conserver" : "Supprimer"}
          </button>
        </div>
      </article>
    `;
  }).join("");
}

function collectPatientDraft() {
  const form = $("patient-form");
  if (!form.reportValidity()) return null;
  const values = Object.fromEntries(new FormData(form).entries());
  const patient = {
    id: state.editingPatient?.id || null,
    cin: normalizeCin(values.cin),
    prenom: normalizeFirst(values.prenom),
    nom: normalizeLast(values.nom),
    age: Number(values.age),
    genre: values.genre,
    handicap: String(values.handicap || "").trim(),
  };
  if (!validMoroccanCin(patient.cin)) {
    setError("patient-error", "Format CIN invalide : une ou deux lettres suivies de cinq ou six chiffres.");
    return null;
  }
  if (!patient.prenom || !patient.nom || !patient.genre || !patient.handicap || !Number.isInteger(patient.age)) {
    setError("patient-error", "Tous les champs patient sont obligatoires.");
    return null;
  }
  setError("patient-error");
  return {
    mode: patient.id ? "update" : "create",
    patient,
    folderText: $("patient-folder-text").value.trim(),
    files: [...state.patientFiles],
    removedDocumentIds: [...state.removedDocumentIds],
  };
}

function renderPatientReview(draft) {
  const rows = [
    ["CIN", draft.patient.cin],
    ["Prénom", draft.patient.prenom],
    ["Nom", draft.patient.nom],
    ["Âge", `${draft.patient.age} ans`],
    ["Genre", draft.patient.genre],
    ["Handicap(s)", draft.patient.handicap],
  ];
  $("patient-review-content").innerHTML = `
    <section>
      <h3>Informations patient</h3>
      <dl class="review-grid">${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>
    </section>
    <section>
      <h3>Dossier médical</h3>
      ${draft.folderText ? `<p class="review-note">${escapeHtml(draft.folderText)}</p>` : '<p class="empty-state-line">Aucun nouveau texte.</p>'}
      ${draft.files.length
        ? `<ul class="review-files">${draft.files.map((file) => `<li>${icon("file")}<span>${escapeHtml(file.name)} · ${escapeHtml(formatBytes(file.size))}</span></li>`).join("")}</ul>`
        : '<p class="empty-state-line">Aucun nouveau fichier.</p>'}
      ${draft.removedDocumentIds.length
        ? `<p class="removal-summary">${draft.removedDocumentIds.length} élément${draft.removedDocumentIds.length > 1 ? "s" : ""} ${draft.removedDocumentIds.length > 1 ? "seront" : "sera"} supprimé${draft.removedDocumentIds.length > 1 ? "s" : ""}.</p>`
        : ""}
    </section>
  `;
}

function submitPatientForm(event) {
  event.preventDefault();
  const draft = collectPatientDraft();
  if (!draft) return;
  state.patientDraft = draft;
  renderPatientReview(draft);
  $("patient-form-step").classList.add("hidden");
  $("patient-review-step").classList.remove("hidden");
}

function confirmPatientReview() {
  if (!state.patientDraft) return;
  const adminEdit = state.patientEditorRole === "admin";
  hide("patient-modal");
  openConfirm({
    title: state.patientDraft.mode === "create" ? "Enregistrer le dossier" : "Enregistrer les modifications",
    text: adminEdit
      ? "Saisissez l'ID de l'administrateur connecté pour confirmer."
      : "Saisissez l'ID du médecin connecté pour confirmer.",
    requireId: true,
    onCancel: () => show("patient-modal"),
    action: async (confirmAccessId) => {
      const patientIdBefore = state.patientDraft.patient.id;
      const result = await savePatientBundle({
        ...state.patientDraft,
        operation: adminEdit ? "admin-save-patient" : "save-patient",
        confirmAccessId,
      });
      const patientId = result.patient_id || patientIdBefore;
      hide("patient-modal");
      state.patientDraft = null;
      toast(patientIdBefore ? "Informations patient mises à jour." : "Dossier patient ajouté.");
      if (adminEdit) {
        await loadAdminData({ activeTab: "patients" });
      } else {
        await loadDoctorData({ selectPatientId: patientId || null });
      }
    },
  });
}

function openFolderModal() {
  if (!currentPatient()) return;
  state.folderFiles = [];
  $("folder-form").reset();
  updateSelectedFiles("folder");
  setError("folder-error");
  show("folder-modal");
}

function submitFolderForm(event) {
  event.preventDefault();
  const text = $("folder-text").value.trim();
  if (!text && !state.folderFiles.length) {
    setError("folder-error", "Ajoutez un texte ou au moins un fichier.");
    return;
  }
  const patientId = state.selectedPatientId;
  const files = [...state.folderFiles];
  hide("folder-modal");
  openConfirm({
    title: "Ajouter au dossier médical",
    text: "Saisissez l'ID du médecin connecté pour confirmer.",
    requireId: true,
    onCancel: () => show("folder-modal"),
    action: async (confirmDoctorId) => {
      await addMedicalFolderBundle({
        dossierId: patientId,
        text,
        files,
        confirmDoctorId,
      });
      toast("Dossier médical mis à jour.");
      await loadDoctorData({ selectPatientId: patientId, section: "medical-folder-section" });
    },
  });
}

async function queueClinicalFile(requestId, blob, safeName, source) {
  const form = new FormData();
  form.append("request_id", requestId);
  form.append("source", source);
  form.append("file", blob, safeName);
  const response = await fetch(CONFIG.mcpUploadUrl, { method: "POST", body: form });
  const data = await parseJsonResponse(response);
  if (!response.ok) throw new Error(data.message || "Le document n'a pas pu être préparé.");
  return data;
}

async function discardClinicalQueue(requestId) {
  if (!requestId) return;
  try {
    await fetch(`${CONFIG.mcpQueueUrl}/${encodeURIComponent(requestId)}`, { method: "DELETE" });
  } catch {
    // The queue also expires automatically; cleanup failure must not mask the original error.
  }
}

async function clearAllClinicalQueues() {
  const response = await fetch(CONFIG.mcpQueueUrl, { method: "DELETE" });
  const data = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(data.message || "Le service local n'a pas pu vider les documents temporaires.");
  }
  return data;
}

function medicalFolderTextForBackend() {
  return documentsForPatient()
    .filter((documentRecord) => !isStoredFile(documentRecord) && documentRecord.contenu)
    .map((documentRecord) => documentRecord.contenu.trim())
    .filter(Boolean);
}

async function prepareClinicalDocuments(requestId, caseFiles) {
  let caseIndex = 0;
  for (const file of caseFiles) {
    caseIndex += 1;
    const extension = file.name.includes(".") ? `.${file.name.split(".").pop().toLowerCase()}` : "";
    await queueClinicalFile(requestId, file, `document_cas_${caseIndex}${extension}`, "case");
  }

  const storedFiles = documentsForPatient().filter(isStoredFile);
  let folderIndex = 0;
  for (const documentRecord of storedFiles) {
    folderIndex += 1;
    const blob = await downloadMedicalFile(documentRecord);
    const original = documentRecord.nom_fichier || "document";
    const extension = original.includes(".") ? `.${original.split(".").pop().toLowerCase()}` : "";
    await queueClinicalFile(
      requestId,
      blob,
      `document_dossier_${folderIndex}${extension}`,
      "medical-folder",
    );
  }
  return { caseCount: caseFiles.length, medicalFolderFileCount: storedFiles.length };
}

function buildClinicalInput(caseText, medicalTextEntries, patientContext) {
  const clinicalProfile = [
    "PROFIL CLINIQUE",
    `Âge : ${patientContext.age} ans`,
    `Genre : ${patientContext.genre}`,
  ].join("\n");
  const medicalSection = medicalTextEntries.length
    ? `DOSSIER MÉDICAL\n${medicalTextEntries.map((entry, index) => `${index + 1}. ${entry}`).join("\n")}`
    : "DOSSIER MÉDICAL\nAucune information textuelle enregistrée.";
  return `${clinicalProfile}\n\n${medicalSection}\n\nNOUVEAU CAS CLINIQUE\n${caseText}`;
}

async function loadProductionWebhookUrl() {
  let response;
  try {
    response = await fetch(
      `${CONFIG.productionWebhookFile}?t=${Date.now()}`,
      { cache: "no-store" },
    );
  } catch {
    throw new Error("Impossible de lire le fichier du webhook de production.");
  }
  if (!response.ok) {
    throw new Error("Impossible de lire le fichier du webhook de production.");
  }

  const configuredUrl = (await response.text()).trim();
  let parsedUrl;
  try {
    parsedUrl = new URL(configuredUrl);
  } catch {
    throw new Error("Le webhook de production indiqué dans PRODUCTION_WEBHOOK.txt est invalide.");
  }
  if (parsedUrl.protocol !== "https:") {
    throw new Error("Le webhook de production doit utiliser une adresse HTTPS.");
  }
  return parsedUrl.href;
}

async function sendClinicalWebhook(payload, url = null) {
  const targetUrl = url || await loadProductionWebhookUrl();
  await fetch(targetUrl, {
    method: "POST",
    mode: "no-cors",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify(payload),
  });
}

async function launchClinicalAnalysis({ draft: retainedDraft = null, retry = false } = {}) {
  const patient = currentPatient();
  if (!patient) return;
  if (state.activeClinicalRequest) {
    const samePatient = state.activeClinicalRequest.patientId === patient.id;
    setError(
      "case-error",
      samePatient
        ? "Une analyse est déjà en cours pour ce patient."
        : "Une autre analyse est déjà en cours. Attendez son rapport avant d'en lancer une nouvelle.",
    );
    if (samePatient) updateClinicalWaitingUi();
    return;
  }
  const text = retainedDraft?.text ?? $("case-text").value.trim();
  const files = retainedDraft?.files ? [...retainedDraft.files] : [...state.caseFiles];
  if (!text) {
    setError("case-error", "La description clinique est obligatoire.");
    $("case-text").focus();
    return;
  }
  if (retainedDraft?.patientId && retainedDraft.patientId !== patient.id) {
    setError("case-error", "Le dossier de relance ne correspond pas au patient sélectionné.");
    return;
  }

  const patientContext = retainedDraft?.patientContext || {
    age: Number(patient.age),
    genre: String(patient.genre || "Non renseigné"),
  };
  const draft = {
    patientId: patient.id,
    text,
    files,
    patientContext,
    createdAt: retainedDraft?.createdAt || Date.now(),
  };
  state.analysisDraft = draft;
  setClinicalProcessing(true);

  setError("case-error");
  hide("pending-report");
  $("case-progress").classList.remove("hidden");
  setDoctorAnalysisLock(true);
  const requestId = crypto.randomUUID();
  let monitoringStarted = false;

  try {
    // Always begin from an empty MCP holding area, even when this request has
    // no uploaded files. This prevents stale documents crossing analyses.
    await clearAllClinicalQueues();
    const counts = await prepareClinicalDocuments(requestId, files);
    const medicalText = medicalFolderTextForBackend();
    const payload = {
      input_value: buildClinicalInput(text, medicalText, draft.patientContext),
      patient_id: patient.id,
      patient_age: draft.patientContext.age,
      patient_genre: draft.patientContext.genre,
      clinical_request_id: requestId,
      mcp_request_id: requestId,
      mcp_tool: "ocr_extract_document",
      dossier_medical_text: medicalText,
      documents: {
        current_case: counts.caseCount,
        medical_folder: counts.medicalFolderFileCount,
      },
    };
    const startedAt = Date.now();
    await sendClinicalWebhook(payload);
    state.pendingReportRaw = null;
    state.pendingReportPatientId = null;
    $("case-text").value = "";
    state.caseFiles = [];
    updateSelectedFiles("case");
    startClinicalMonitoring({
      requestId,
      patientId: patient.id,
      startedAt,
    }, { scroll: true });
    monitoringStarted = true;
    void recordAnalysisActivity({
      dossierId: patient.id,
      requestId,
      retry,
    }).catch(() => {
      toast("L'analyse est lancée, mais son entrée de journal n'a pas pu être enregistrée.", "warning");
    });
    toast(retry
      ? "Analyse relancée avec les mêmes informations."
      : "Analyse lancée. Le rapport s'affichera automatiquement.");
  } catch (error) {
    await discardClinicalQueue(requestId);
    $("case-text").value = draft.text;
    state.caseFiles = [...draft.files];
    updateSelectedFiles("case");
    state.analysisDraft = null;
    setClinicalProcessing(false);
    setDoctorAnalysisLock(false);
    setError("case-error", friendlyError(error));
  } finally {
    $("case-progress").classList.add("hidden");
    if (!monitoringStarted) {
      setClinicalProcessing(false);
      setDoctorAnalysisLock(false);
    }
  }
}

function extractReport(payload) {
  if (typeof payload === "string") {
    const value = payload.trim();
    if (!value) return null;
    try {
      return extractReport(JSON.parse(value));
    } catch {
      return value;
    }
  }
  if (!payload || typeof payload !== "object") return null;
  for (const key of [
    "rapport_final_detaille",
    "rapport_text",
    "report",
    "message",
    "output",
    "text",
    "result",
  ]) {
    if (typeof payload[key] === "string" && payload[key].trim()) return payload[key];
  }
  for (const child of Object.values(payload)) {
    if (!child || typeof child !== "object") continue;
    const found = extractReport(child);
    if (found) return found;
  }
  return null;
}

function extractPatientId(payload) {
  if (!payload || typeof payload !== "object") return null;
  for (const key of ["patient_id", "dossier_id"]) {
    if (typeof payload[key] === "string") return payload[key];
  }
  for (const child of Object.values(payload)) {
    const found = extractPatientId(child);
    if (found) return found;
  }
  return null;
}

function extractRequestId(payload) {
  if (!payload || typeof payload !== "object") return null;
  for (const key of ["clinical_request_id", "mcp_request_id", "request_id"]) {
    if (typeof payload[key] === "string") return payload[key];
  }
  for (const child of Object.values(payload)) {
    if (!child || typeof child !== "object") continue;
    const found = extractRequestId(child);
    if (found) return found;
  }
  return null;
}

function mailboxUrlSince(startedAt) {
  const url = new URL(CONFIG.testMailboxUrl);
  url.searchParams.set("poll", "1");
  url.searchParams.set("since", String(Math.max(0, Math.floor(Number(startedAt) / 1000) - 1)));
  return url;
}

async function fetchMailboxEventsSince(startedAt) {
  const response = await fetch(mailboxUrlSince(startedAt), { cache: "no-store" });
  if (!response.ok) throw new Error(`Réception indisponible (${response.status}).`);
  const raw = await response.text();
  return raw
    .split(/\r?\n/)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((event) => event?.event === "message")
    .filter((event) => !event.time || event.time * 1000 >= Number(startedAt) - 1_000)
    .sort((first, second) => Number(first.time || 0) - Number(second.time || 0));
}

async function readNtfyEventPayload(event) {
  let payload = event?.message || "";
  if (event?.attachment?.url) {
    const attachmentResponse = await fetch(event.attachment.url, { cache: "no-store" });
    if (!attachmentResponse.ok) {
      throw new Error(`Pièce jointe indisponible (${attachmentResponse.status}).`);
    }
    const attachmentText = await attachmentResponse.text();
    try {
      payload = JSON.parse(attachmentText);
    } catch {
      payload = attachmentText;
    }
  } else if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      // A direct plain-text report is valid.
    }
  }
  return payload;
}

async function completeActiveClinicalRequest(report, patientId) {
  const request = state.activeClinicalRequest;
  if (!request) return;
  stopClinicalMonitoringTimers();
  request.connectionInterrupted = false;
  $("analysis-progress-fill").style.width = "100%";
  $("analysis-progress-track").setAttribute("aria-valuenow", "100");
  $("analysis-progress-track").setAttribute("aria-valuetext", "Rapport reçu");
  $("analysis-processing-status").textContent = "Rapport reçu.";
  $("analysis-processing-time").textContent = formatElapsedTime(Date.now() - request.startedAt);
  await new Promise((resolve) => setTimeout(resolve, 450));
  stageIncomingReport(report, patientId || request.patientId);
}

function failActiveClinicalRequest(message) {
  const request = state.activeClinicalRequest;
  const patientId = request?.patientId;
  const draft = state.analysisDraft;
  setClinicalProcessing(false);
  clearActiveClinicalRequest();
  if (draft?.patientId === patientId) {
    $("case-text").value = draft.text;
    state.caseFiles = [...draft.files];
    updateSelectedFiles("case");
  }
  state.analysisDraft = null;
  if (patientId && patientId === state.selectedPatientId) {
    setError("case-error", message);
  }
  toast(message, "warning");
}

async function pollActiveClinicalMailbox(generation) {
  if (generation !== state.clinicalMonitorGeneration) return;
  const request = state.activeClinicalRequest;
  if (!request || state.role !== "doctor" || state.pendingReportRaw) return;
  if (Date.now() - request.startedAt >= CONFIG.clinicalReturnTimeoutMs) {
    failActiveClinicalRequest("Aucun rapport n'a été reçu dans le délai prévu. Vous pouvez relancer l'analyse.");
    return;
  }

  try {
    const events = await fetchMailboxEventsSince(request.startedAt);
    for (const event of events) {
      if (!event.id || request.seenEventIds.has(event.id)) continue;
      let payload;
      try {
        payload = await readNtfyEventPayload(event);
      } catch {
        continue;
      }
      request.seenEventIds.add(event.id);

      const returnedRequestId = extractRequestId(payload);
      if (returnedRequestId && returnedRequestId !== request.requestId) continue;
      const returnedPatientId = extractPatientId(payload);
      if (returnedPatientId && returnedPatientId !== request.patientId) continue;
      const report = extractReport(payload);
      if (!report) continue;

      await completeActiveClinicalRequest(report, returnedPatientId || request.patientId);
      return;
    }
    request.connectionInterrupted = false;
  } catch {
    request.connectionInterrupted = true;
  }

  updateClinicalWaitingUi();
  if (generation !== state.clinicalMonitorGeneration || !state.activeClinicalRequest) return;
  state.clinicalPollTimer = setTimeout(
    () => void pollActiveClinicalMailbox(generation),
    CONFIG.clinicalPollIntervalMs,
  );
}

function stageIncomingReport(rawReport, patientId = null) {
  if (patientId && state.patients.some((patient) => patient.id === patientId)) {
    selectPatient(patientId, { force: true });
  }
  if (!currentPatient()) {
    toast("Rapport reçu. Sélectionnez le patient concerné avant de l'enregistrer.", "warning");
    return;
  }
  state.pendingReportRaw = String(rawReport);
  state.pendingReportPatientId = patientId || state.selectedPatientId;
  setClinicalProcessing(false);
  hide("analysis-waiting");
  $("pending-report-text").textContent = cleanReportForDisplay(rawReport);
  show("pending-report");
  showPatientSection("case-section");
  setDoctorAnalysisLock(true);
}

async function pollTestMailbox() {
  const output = $("test-output");
  output.textContent = "Recherche de la dernière réponse…";
  try {
    const events = await fetchMailboxEventsSince(state.testStartedAt);
    const event = events.at(-1);
    if (!event) {
      output.textContent = "Aucune nouvelle réponse.";
      return;
    }

    const payload = await readNtfyEventPayload(event);
    const report = extractReport(payload);
    if (!report) {
      output.textContent = "Réponse reçue, mais aucun rapport lisible n'a été trouvé.";
      return;
    }
    output.textContent = cleanReportForDisplay(report);
  } catch (error) {
    output.textContent = friendlyError(error);
  }
}

async function sendBackendTest() {
  const message = $("test-message").value.trim();
  if (!message) return;
  const button = $("test-send");
  setButtonBusy(button, true, "Envoi…");
  try {
    await sendClinicalWebhook({
      input_value: message,
      message,
      system: "MSOB AI connection test",
      test: true,
    }, CONFIG.testWebhookUrl);
    $("test-output").textContent = "Message envoyé.";
  } catch (error) {
    $("test-output").textContent = friendlyError(error);
  } finally {
    setButtonBusy(button, false);
  }
}

function confirmPendingReport() {
  if (!state.pendingReportRaw || !currentPatient()) return;
  const patientId = state.selectedPatientId;
  openConfirm({
    title: "Enregistrer le rapport",
    text: "Saisissez l'ID du médecin connecté pour confirmer.",
    requireId: true,
    action: async (confirmDoctorId) => {
      await saveReportBundle({
        confirmDoctorId,
        dossierId: patientId,
        reportText: state.pendingReportRaw,
      });
      state.pendingReportRaw = null;
      state.pendingReportPatientId = null;
      state.analysisDraft = null;
      clearActiveClinicalRequest();
      void clearAllClinicalQueues().catch(() => {});
      toast("Rapport enregistré.");
      await loadDoctorData({ selectPatientId: patientId, section: "history-section" });
    },
  });
}

async function retryPendingReport() {
  const draft = state.analysisDraft;
  state.pendingReportRaw = null;
  state.pendingReportPatientId = null;
  clearActiveClinicalRequest({ unlock: false });
  hide("pending-report");
  if (!draft) {
    setClinicalProcessing(false);
    setDoctorAnalysisLock(false);
    $("case-text").focus();
    return;
  }
  setDoctorAnalysisLock(true);
  await launchClinicalAnalysis({ draft, retry: true });
}

function requestRetryPendingReport() {
  if (!state.pendingReportRaw || !currentPatient()) return;
  openConfirm({
    title: "Relancer l'analyse",
    text: "Le rapport reçu sera écarté sans être enregistré. La même description clinique et les mêmes documents seront renvoyés.",
    requireId: false,
    action: retryPendingReport,
  });
}

function openDoctorModal(doctor = null) {
  state.editingDoctor = doctor;
  const form = $("doctor-form");
  form.reset();
  $("doctor-modal-title").textContent = doctor ? "Modifier le médecin" : "Ajouter un médecin";
  form.elements.prenom.value = doctor?.prenom || "";
  form.elements.nom.value = doctor?.nom || "";
  form.elements.doctor_id.value = doctor?.doctor_id || "";
  setError("doctor-error");
  show("doctor-modal");
}

function submitDoctorForm(event) {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget).entries());
  const doctor = {
    id: state.editingDoctor?.id || null,
    prenom: normalizeFirst(values.prenom),
    nom: normalizeLast(values.nom),
    doctor_id: String(values.doctor_id || "").trim().toLowerCase(),
  };
  if (!validAccessId(doctor.doctor_id)) {
    setError("doctor-error", "L'ID doit contenir 8 à 10 lettres et chiffres, avec au moins une lettre et un chiffre.");
    return;
  }
  hide("doctor-modal");
  openConfirm({
    title: doctor.id ? "Modifier le médecin" : "Ajouter le médecin",
    text: "Saisissez votre ID administrateur pour confirmer.",
    requireId: true,
    onCancel: () => show("doctor-modal"),
    action: async (confirmAdminId) => {
      await manageDoctorBundle("admin-save-doctor", confirmAdminId, doctor);
      toast(doctor.id ? "Médecin modifié." : "Médecin ajouté.");
      await loadAdminData();
    },
  });
}

function setAdminTab(tab) {
  const allowedTabs = new Set(["doctors", "patients", "test", "logs"]);
  state.adminActiveTab = allowedTabs.has(tab) ? tab : "doctors";
  $$("[data-admin-tab]").forEach((button) => {
    const active = button.dataset.adminTab === state.adminActiveTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  $("admin-doctors-panel").classList.toggle("hidden", state.adminActiveTab !== "doctors");
  $("admin-patients-panel").classList.toggle("hidden", state.adminActiveTab !== "patients");
  $("admin-test-panel").classList.toggle("hidden", state.adminActiveTab !== "test");
  const logsPanel = $("admin-logs-panel");
  if (logsPanel) logsPanel.classList.toggle("hidden", state.adminActiveTab !== "logs");
  if (state.adminActiveTab === "test") {
    state.testStartedAt = Date.now();
    $("test-output").textContent = "";
  }
  if (state.adminActiveTab === "logs") void loadAdminActivityLogs();
}

const ACTIVITY_LABELS = Object.freeze({
  "patient.created": "Patient ajouté",
  "patient.updated": "Patient modifié",
  "patient.deleted": "Patient supprimé",
  "medical_folder.added": "Dossier médical enrichi",
  "medical_folder.updated": "Dossier médical modifié",
  "report.confirmed": "Rapport confirmé",
  "analysis.launched": "Analyse lancée",
  "analysis.retried": "Analyse relancée",
  "doctor.created": "Médecin ajouté",
  "doctor.updated": "Médecin modifié",
  "doctor.deleted": "Médecin retiré",
});

function renderAdminActivityLogs() {
  const search = $("admin-log-search").value.trim().toLocaleLowerCase("fr-FR");
  const role = $("admin-log-role").value;
  const logs = state.adminLogs.filter((entry) => {
    if (role && entry.actor_type !== role) return false;
    const haystack = [
      entry.actor_prenom,
      entry.actor_nom,
      entry.actor_access_id,
      entry.target_label,
      ACTIVITY_LABELS[entry.action] || entry.action,
    ].join(" ").toLocaleLowerCase("fr-FR");
    return !search || haystack.includes(search);
  });

  $("admin-log-list").innerHTML = logs.length ? logs.map((entry) => `
    <article class="admin-log-entry">
      <time datetime="${escapeHtml(entry.created_at)}">${escapeHtml(formatDateTime(entry.created_at))}</time>
      <div class="admin-log-action">
        <strong>${escapeHtml(ACTIVITY_LABELS[entry.action] || entry.action)}</strong>
        <span>${escapeHtml(entry.target_label || entry.target_id || "Cible non précisée")}</span>
      </div>
      <div class="admin-log-actor">
        <span>${entry.actor_type === "doctor" ? "Médecin" : "Administrateur"}</span>
        <strong>${escapeHtml(entry.actor_prenom)} ${escapeHtml(entry.actor_nom)}</strong>
        <code>${escapeHtml(entry.actor_access_id)}</code>
      </div>
    </article>
  `).join("") : '<p class="empty-state-line">Aucune activité correspondante.</p>';
}

async function loadAdminActivityLogs() {
  const container = $("admin-log-list");
  if (!container || state.role !== "admin") return;
  container.innerHTML = '<p class="empty-state-line">Chargement du journal…</p>';
  try {
    state.adminLogs = await fetchAdminActivityLogs();
    renderAdminActivityLogs();
  } catch (error) {
    container.innerHTML = `<p class="form-error">${escapeHtml(friendlyError(error))}</p>`;
  }
}

function renderAdminDoctors() {
  $("doctor-list").innerHTML = state.adminDoctors.length ? state.adminDoctors.map((doctor) => `
    <li class="admin-record-row">
      <div class="admin-record-main">
        <strong>${escapeHtml(doctor.prenom)} ${escapeHtml(doctor.nom)}</strong>
        <span>${escapeHtml(doctor.doctor_id)}</span>
      </div>
      <div class="doctor-actions">
        <button class="outline compact" type="button" data-edit-doctor="${doctor.id}">Modifier</button>
        <button class="danger-outline compact" type="button" data-delete-doctor="${doctor.id}">Retirer</button>
      </div>
    </li>
  `).join("") : '<li class="empty-state-line">Aucun médecin autorisé.</li>';
}

function renderAdminPatientList() {
  const term = $("admin-patient-search").value.trim().toLocaleLowerCase("fr-FR");
  const patients = [...state.patients]
    .sort((first, second) => {
      const firstName = first.prenom.localeCompare(second.prenom, "fr", { sensitivity: "base" });
      return firstName || first.nom.localeCompare(second.nom, "fr", { sensitivity: "base" });
    })
    .filter((patient) => (
      `${patient.prenom} ${patient.nom} ${patient.cin}`
        .toLocaleLowerCase("fr-FR")
        .includes(term)
    ));

  $("admin-patient-list").innerHTML = patients.length ? patients.map((patient) => `
    <li class="admin-record-row">
      <div class="admin-record-main">
        <strong>${escapeHtml(patient.prenom)} ${escapeHtml(patient.nom)}</strong>
        <span>${escapeHtml(patient.cin)} · ${escapeHtml(String(patient.age))} ans</span>
      </div>
      <div class="admin-patient-actions">
        <button class="outline compact" type="button" data-admin-edit-patient="${patient.id}">Modifier</button>
        <button class="danger-outline compact" type="button" data-admin-delete-patient="${patient.id}">Supprimer</button>
      </div>
    </li>
  `).join("") : '<li class="empty-state-line">Aucun patient correspondant.</li>';
}

async function loadAdminData({ activeTab = state.adminActiveTab } = {}) {
  state.role = "admin";
  showOnlyArea("admin-area");
  $("admin-name").textContent = `${state.actor.prenom} ${state.actor.nom}`;
  history.replaceState(null, "", `${location.pathname}#admin`);
  const [doctorData, patientData] = await Promise.all([
    gateway("list-doctors"),
    fetchAdminPatientData(),
  ]);
  state.adminDoctors = [...(doctorData.doctors || [])].sort((first, second) => {
    const firstName = first.prenom.localeCompare(second.prenom, "fr", { sensitivity: "base" });
    return firstName || first.nom.localeCompare(second.nom, "fr", { sensitivity: "base" });
  });
  state.patients = Array.isArray(patientData.patients) ? patientData.patients : [];
  state.reports = Array.isArray(patientData.reports) ? patientData.reports : [];
  state.documents = Array.isArray(patientData.documents) ? patientData.documents : [];
  renderAdminDoctors();
  renderAdminPatientList();
  setAdminTab(activeTab);
}

function patientFullName(patient) {
  return `${patient.prenom} ${patient.nom}`;
}

function showDeletePatientStep(step) {
  $("delete-patient-warning-step").classList.toggle("hidden", step !== "warning");
  $("delete-patient-name-step").classList.toggle("hidden", step !== "name");
  $("delete-patient-admin-step").classList.toggle("hidden", step !== "admin");
}

function closeDeletePatientModal() {
  hide("delete-patient-modal");
  state.deletePatientTarget = null;
  $("delete-patient-form").reset();
  setError("delete-patient-name-error");
  setError("delete-patient-admin-error");
  showDeletePatientStep("warning");
}

function openDeletePatientModal(patient) {
  if (!patient) return;
  state.deletePatientTarget = patient;
  const fullName = patientFullName(patient);
  $("delete-patient-warning-name").textContent = fullName;
  $("delete-patient-required-name").textContent = fullName;
  $("delete-patient-form").reset();
  setError("delete-patient-name-error");
  setError("delete-patient-admin-error");
  showDeletePatientStep("warning");
  show("delete-patient-modal");
}

function continueDeletePatientName() {
  const patient = state.deletePatientTarget;
  if (!patient) return;
  const expected = patientFullName(patient);
  if ($("delete-patient-name-input").value.trim() !== expected) {
    setError("delete-patient-name-error", `Saisissez exactement « ${expected} ».`);
    return;
  }
  setError("delete-patient-name-error");
  showDeletePatientStep("admin");
  setTimeout(() => $("delete-patient-admin-id").focus(), 0);
}

async function submitDeletePatient(event) {
  event.preventDefault();
  const patient = state.deletePatientTarget;
  if (!patient) return;
  const confirmAdminId = $("delete-patient-admin-id").value.trim().toLowerCase();
  if (!validAccessId(confirmAdminId)) {
    setError("delete-patient-admin-error", "Saisissez un ID administrateur valide.");
    return;
  }
  const button = event.submitter || event.currentTarget.querySelector('[type="submit"]');
  setButtonBusy(button, true, "Suppression…");
  try {
    const result = await deletePatientBundle({
      patientId: patient.id,
      patientFullName: patientFullName(patient),
      confirmAdminId,
    });
    closeDeletePatientModal();
    toast("Patient et données associées supprimés.");
    if (result.storage_cleanup_warning) {
      toast("Les données visibles sont supprimées, mais un fichier privé nécessite une nouvelle tentative de nettoyage.", "warning");
    }
    await loadAdminData({ activeTab: "patients" });
  } catch (error) {
    setError("delete-patient-admin-error", friendlyError(error));
  } finally {
    setButtonBusy(button, false);
  }
}

function requestDeleteDoctor(doctorId) {
  openConfirm({
    title: "Retirer ce médecin",
    text: "Saisissez votre ID administrateur pour confirmer.",
    requireId: true,
    action: async (confirmAdminId) => {
      await manageDoctorBundle("admin-delete-doctor", confirmAdminId, { id: doctorId });
      toast("Accès médecin retiré.");
      await loadAdminData();
    },
  });
}

function openConfirm({ title, text, action, requireId = true, onCancel = null }) {
  state.confirmAction = action;
  state.confirmCancel = onCancel;
  $("confirm-title").textContent = title;
  $("confirm-text").textContent = text;
  $("confirm-id").value = "";
  $("confirm-id").required = requireId;
  $("confirm-id-label").classList.toggle("hidden", !requireId);
  setError("confirm-error");
  show("confirm-modal");
  if (requireId) setTimeout(() => $("confirm-id").focus(), 0);
}

function closeConfirm({ cancelled = true } = {}) {
  hide("confirm-modal");
  const onCancel = state.confirmCancel;
  state.confirmAction = null;
  state.confirmCancel = null;
  if (cancelled && onCancel) onCancel();
}

async function submitConfirm(event) {
  event.preventDefault();
  const confirmId = $("confirm-id").value.trim().toLowerCase();
  if (!$("confirm-id-label").classList.contains("hidden") && !validAccessId(confirmId)) {
    setError("confirm-error", "Saisissez un ID valide.");
    return;
  }
  const action = state.confirmAction;
  if (!action) return;
  const button = event.submitter || event.currentTarget.querySelector('[type="submit"]');
  setButtonBusy(button, true, "Traitement…");
  try {
    await action(confirmId);
    closeConfirm({ cancelled: false });
  } catch (error) {
    setError("confirm-error", friendlyError(error));
  } finally {
    setButtonBusy(button, false);
  }
}

function requestReturnToChoice() {
  if (state.role === "doctor" && analysisIsUnresolved()) return;
  openConfirm({
    title: "Changer d'espace",
    text: "Quitter l'espace actuel et revenir au choix Médecin / Administration ?",
    requireId: false,
    action: async () => {
      if (state.role === "doctor") clearDoctorSession();
      state.role = null;
      state.token = null;
      state.actor = null;
      state.selectedPatientId = null;
      history.replaceState(null, "", location.pathname);
      showOnlyArea("landing");
    },
  });
}

function closeModalByAttribute(attribute, modalId) {
  $$(`[${attribute}]`).forEach((button) => button.addEventListener("click", () => hide(modalId)));
}

function bindEvents() {
  $$("[data-role]").forEach((button) => button.addEventListener("click", () => openUnlock(button.dataset.role)));
  $("unlock-form").addEventListener("submit", submitUnlock);
  $("patient-search").addEventListener("input", renderPatientList);
  $("doctor-home").addEventListener("click", doctorHome);
  $("add-patient").addEventListener("click", () => openPatientModal());
  $("edit-patient").addEventListener("click", () => openPatientModal(currentPatient()));
  $("open-new-case").addEventListener("click", () => openPatientSection("case-section"));
  $("open-medical-folder").addEventListener("click", () => openPatientSection("medical-folder-section"));
  $("open-report-history").addEventListener("click", () => openPatientSection("history-section"));
  $$(".back-patient").forEach((button) => button.addEventListener("click", () => showPatientSection("patient-menu")));
  $("add-to-folder").addEventListener("click", openFolderModal);
  $("launch-analysis").addEventListener("click", () => void launchClinicalAnalysis());
  $("confirm-pending-report").addEventListener("click", confirmPendingReport);
  $("retry-report").addEventListener("click", requestRetryPendingReport);
  $("download-report").addEventListener("click", downloadSelectedReportPdf);
  $("test-send").addEventListener("click", () => void sendBackendTest());
  $("test-poll").addEventListener("click", () => void pollTestMailbox());
  $("patient-form").addEventListener("submit", submitPatientForm);
  $("patient-review-back").addEventListener("click", () => {
    $("patient-review-step").classList.add("hidden");
    $("patient-form-step").classList.remove("hidden");
  });
  $("patient-review-confirm").addEventListener("click", confirmPatientReview);
  $("folder-form").addEventListener("submit", submitFolderForm);
  $("doctor-form").addEventListener("submit", submitDoctorForm);
  $("add-doctor").addEventListener("click", () => openDoctorModal());
  $("admin-add-patient").addEventListener("click", () => openPatientModal(null, { editorRole: "admin" }));
  $$("[data-admin-tab]").forEach((button) => {
    button.addEventListener("click", () => setAdminTab(button.dataset.adminTab));
  });
  $("admin-patient-search").addEventListener("input", renderAdminPatientList);
  $("admin-log-search").addEventListener("input", renderAdminActivityLogs);
  $("admin-log-role").addEventListener("change", renderAdminActivityLogs);
  $("refresh-admin-logs").addEventListener("click", () => void loadAdminActivityLogs());
  $("delete-patient-warning-next").addEventListener("click", () => {
    showDeletePatientStep("name");
    setTimeout(() => $("delete-patient-name-input").focus(), 0);
  });
  $("delete-patient-name-back").addEventListener("click", () => showDeletePatientStep("warning"));
  $("delete-patient-name-next").addEventListener("click", continueDeletePatientName);
  $("delete-patient-admin-back").addEventListener("click", () => showDeletePatientStep("name"));
  $("delete-patient-form").addEventListener("submit", submitDeletePatient);
  $("confirm-form").addEventListener("submit", submitConfirm);
  $$("[data-back-choice]").forEach((button) => button.addEventListener("click", requestReturnToChoice));

  closeModalByAttribute("data-close-unlock", "unlock-modal");
  $$("[data-close-unlock]").forEach((button) => {
    button.addEventListener("click", () => setAssistantContext("landing"));
  });
  closeModalByAttribute("data-close-patient", "patient-modal");
  closeModalByAttribute("data-close-folder", "folder-modal");
  closeModalByAttribute("data-close-doctor", "doctor-modal");
  $$("[data-close-delete-patient]").forEach((button) => button.addEventListener("click", closeDeletePatientModal));
  $$("[data-close-confirm]").forEach((button) => button.addEventListener("click", () => closeConfirm()));

  $("patient-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-patient-id]");
    if (button) selectPatient(button.dataset.patientId);
  });
  $("medical-folder-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-download-document]");
    if (button) void handleDocumentDownload(button.dataset.downloadDocument, button);
  });
  $("history-report-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-history-report]");
    if (button) renderReportHistory(button.dataset.historyReport);
  });
  $("existing-folder-list").addEventListener("click", (event) => {
    const removeButton = event.target.closest("[data-toggle-remove-document]");
    if (removeButton) {
      const documentId = removeButton.dataset.toggleRemoveDocument;
      if (state.removedDocumentIds.has(documentId)) state.removedDocumentIds.delete(documentId);
      else state.removedDocumentIds.add(documentId);
      renderExistingFolderEditor();
      return;
    }
    const downloadButton = event.target.closest("[data-edit-download]");
    if (downloadButton) void handleDocumentDownload(downloadButton.dataset.editDownload, downloadButton);
  });
  $("doctor-list").addEventListener("click", (event) => {
    const edit = event.target.closest("[data-edit-doctor]");
    if (edit) {
      openDoctorModal(state.adminDoctors.find((doctor) => doctor.id === edit.dataset.editDoctor));
      return;
    }
    const remove = event.target.closest("[data-delete-doctor]");
    if (remove) requestDeleteDoctor(remove.dataset.deleteDoctor);
  });
  $("admin-patient-list").addEventListener("click", (event) => {
    const edit = event.target.closest("[data-admin-edit-patient]");
    if (edit) {
      const patient = state.patients.find((item) => item.id === edit.dataset.adminEditPatient);
      openPatientModal(patient, { editorRole: "admin" });
      return;
    }
    const remove = event.target.closest("[data-admin-delete-patient]");
    if (remove) {
      openDeletePatientModal(
        state.patients.find((item) => item.id === remove.dataset.adminDeletePatient),
      );
    }
  });

  document.addEventListener("click", (event) => {
    for (const kind of ["case", "patient", "folder"]) {
      const remove = event.target.closest(`[data-remove-${kind}-file]`);
      if (!remove) continue;
      state[`${kind}Files`].splice(Number(remove.dataset[`remove${kind[0].toUpperCase()}${kind.slice(1)}File`]), 1);
      updateSelectedFiles(kind);
      break;
    }
  });

  bindDropZone("case-drop-zone", "case-file-input", "case");
  bindDropZone("patient-drop-zone", "patient-file-input", "patient");
  bindDropZone("folder-drop-zone", "folder-file-input", "folder");

  const activity = (event) => {
    if (event.target?.closest?.("#doctor-mascot-container")) return;
    void markDoctorActivity();
  };
  for (const eventName of ["pointerdown", "keydown", "touchstart"]) {
    document.addEventListener(eventName, activity, { passive: true });
  }

  window.addEventListener("beforeunload", (event) => {
    if (state.role !== "doctor" || !analysisIsUnresolved()) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

async function initialize() {
  // Clinical requests are intentionally memory-only. Refreshing cancels the
  // browser side of a request; any old pre-v2 persisted marker is discarded.
  localStorage.removeItem(CONFIG.legacyClinicalRequestKey);
  renderStaticIcons();
  bindEvents();
  $("test-output").textContent = "";
  setInterval(() => {
    if (state.role !== "doctor") return;
    if (analysisIsProcessing()) {
      // Keep both the local timestamp and the server session fresh while the
      // backend is processing. The 30-minute idle window restarts afterward.
      void markDoctorActivity();
      return;
    }
    if (Date.now() - state.doctorLastActivity >= CONFIG.doctorIdleMs) {
      void expireDoctorSession("Votre session a expiré après 30 minutes d'inactivité.");
    }
  }, 15_000);

  const restored = await restoreDoctorSession();
  if (!restored) showOnlyArea("landing");
  hide("app-loading");
}

window.addEventListener("DOMContentLoaded", () => {
  void initialize();
});
