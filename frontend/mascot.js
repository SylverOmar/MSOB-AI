"use strict";

window.addEventListener("DOMContentLoaded", () => {
  const mascot = document.getElementById("doctor-mascot-container");
  const mascotBody = document.getElementById("mascot-body-element");
  const robotEyes = document.getElementById("robot-eyes");
  const robotHeartbeatPulse = document.getElementById("robot-heartbeat-pulse");
  const robotHead = document.getElementById("robot-head");
  const visorTimer = document.getElementById("visor-timer");
  const panel = document.getElementById("assistant-panel");
  const chatLog = document.getElementById("assistant-chat-log");
  const closeButton = document.getElementById("close-assistant");
  const bubble = document.getElementById("mascot-bubble");
  const suggestions = panel?.querySelector(".assistant-suggestions");
  if (!mascot || !mascotBody || !panel) return;

  let dragging = false;
  let justDragged = false;
  let offsetX = 0;
  let offsetY = 0;
  let waveTimeout = 0;
  let typingAnswer = false;

  const analysisActive = () => Boolean(window.MSOBSession?.analysisInProgress);

  const countdownActive = () => {
    const session = window.MSOBSession;
    if (analysisActive()) return false;
    if (!session || session.role !== "doctor" || !session.lastActivity) return false;
    const inactive = Date.now() - session.lastActivity;
    return inactive >= session.countdownDelayMs && inactive < session.idleLimitMs;
  };

  function setStillPose() {
    clearTimeout(waveTimeout);
    mascot.classList.remove("mascot-waving");
    if (robotHead) robotHead.style.transform = "rotate(0deg)";
    if (robotEyes) robotEyes.style.transform = "translate3d(0,0,0)";
  }

  function positionBubble() {
    if (!bubble) return;
    const mascotRect = mascot.getBoundingClientRect();
    const bodyRect = mascotBody.getBoundingClientRect();
    const bubbleWidth = bubble.offsetWidth || 205;
    const bubbleHeight = bubble.offsetHeight || 60;
    const margin = 10;
    const desiredViewportLeft = bodyRect.left + (bodyRect.width / 2) - (bubbleWidth / 2);
    const viewportLeft = Math.max(
      margin,
      Math.min(window.innerWidth - bubbleWidth - margin, desiredViewportLeft),
    );
    const arrowViewportLeft = Math.max(
      14,
      Math.min(bubbleWidth - 14, bodyRect.left + (bodyRect.width / 2) - viewportLeft),
    );
    bubble.style.left = `${viewportLeft - mascotRect.left}px`;
    bubble.style.setProperty("--bubble-arrow-left", `${arrowViewportLeft}px`);
    mascot.classList.toggle("bubble-below", bodyRect.top < bubbleHeight + 18);
  }

  function refreshCountdown() {
    const session = window.MSOBSession;
    const processing = analysisActive();
    mascot.classList.toggle("mascot-analysis-active", processing);
    if (processing) {
      setStillPose();
      if (visorTimer) visorTimer.style.display = "none";
      if (robotEyes) robotEyes.style.display = "none";
      if (robotHeartbeatPulse) robotHeartbeatPulse.style.display = "block";
      return;
    }
    if (
      session?.role === "doctor"
      && session.lastActivity
      && Date.now() - session.lastActivity >= session.idleLimitMs
    ) {
      setStillPose();
      if (visorTimer) {
        visorTimer.textContent = "00:00";
        visorTimer.style.display = "block";
      }
      if (robotEyes) robotEyes.style.display = "none";
      session.expireIfIdle?.();
      return;
    }
    if (robotHeartbeatPulse) robotHeartbeatPulse.style.display = "none";
    if (countdownActive()) {
      setStillPose();
      panel.classList.add("hidden");
      panel.setAttribute("aria-hidden", "true");
      const remaining = Math.max(0, session.idleLimitMs - (Date.now() - session.lastActivity));
      const totalSeconds = Math.ceil(remaining / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      visorTimer.textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
      visorTimer.style.display = "block";
      robotEyes.style.display = "none";
    } else {
      visorTimer.style.display = "none";
      robotEyes.style.display = "block";
    }
  }

  mascot.addEventListener("dragstart", (event) => event.preventDefault());
  mascot.addEventListener("mouseenter", () => {
    positionBubble();
    if (analysisActive() || countdownActive()) {
      setStillPose();
      return;
    }
    mascot.classList.add("mascot-waving");
    clearTimeout(waveTimeout);
    waveTimeout = setTimeout(() => {
      mascot.classList.remove("mascot-waving");
      if (robotHead) robotHead.style.transform = "rotate(0deg)";
    }, 1800);
  });
  mascot.addEventListener("mouseleave", () => {
    clearTimeout(waveTimeout);
    mascot.classList.remove("mascot-waving");
    if (robotHead) robotHead.style.transform = "rotate(0deg)";
  });

  document.addEventListener("mousemove", (event) => {
    if (analysisActive() || countdownActive()) {
      setStillPose();
      return;
    }
    if (robotEyes) {
      const rect = robotEyes.getBoundingClientRect();
      const dx = event.clientX - (rect.left + rect.width / 2);
      const dy = event.clientY - (rect.top + rect.height / 2);
      const angle = Math.atan2(dy, dx);
      const distance = Math.min(4, Math.hypot(dx, dy) / 45);
      robotEyes.style.transform = `translate3d(${Math.cos(angle) * distance}px,${Math.sin(angle) * distance}px,0)`;
    }
  });

  function positionPanel(left, top) {
    const width = 330;
    const height = 430;
    const robotWidth = mascotBody.offsetWidth;
    const robotHeight = mascotBody.offsetHeight;
    const centerX = left + robotWidth / 2;
    const centerY = top + robotHeight / 2;
    const candidates = [
      { x: centerX - width / 2, y: centerY - height - 75 },
      { x: centerX - width - 85, y: centerY - height / 2 },
      { x: centerX + 85, y: centerY - height / 2 },
      { x: centerX - width / 2, y: centerY + 85 },
    ];
    let selected = null;
    let smallestOverlap = Infinity;
    for (const candidate of candidates) {
      const x = Math.max(15, Math.min(window.innerWidth - width - 15, candidate.x));
      const y = Math.max(15, Math.min(window.innerHeight - height - 15, candidate.y));
      const overlapX = Math.max(0, Math.min(left + robotWidth, x + width) - Math.max(left, x));
      const overlapY = Math.max(0, Math.min(top + robotHeight, y + height) - Math.max(top, y));
      const overlap = overlapX * overlapY;
      if (overlap < smallestOverlap) {
        smallestOverlap = overlap;
        selected = { x, y };
      }
    }
    panel.style.left = `${selected.x}px`;
    panel.style.top = `${selected.y}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }

  mascot.addEventListener("click", (event) => {
    if (mascot.dataset.wasDragging === "true") {
      mascot.dataset.wasDragging = "false";
      return;
    }
    if (event.target.closest(".mascot-speech-bubble")) return;
    panel.classList.toggle("hidden");
    panel.setAttribute("aria-hidden", panel.classList.contains("hidden") ? "true" : "false");
    if (!panel.classList.contains("hidden")) {
      window.MSOBSession?.markActivity();
      bubble.style.opacity = "0";
      const rect = mascot.getBoundingClientRect();
      positionPanel(rect.left, rect.top);
    }
  });
  closeButton.addEventListener("click", () => {
    panel.classList.add("hidden");
    panel.setAttribute("aria-hidden", "true");
    bubble.style.opacity = "";
  });
  document.addEventListener("click", (event) => {
    if (justDragged || panel.classList.contains("hidden")) return;
    if (!event.target.closest("#assistant-panel") && !event.target.closest("#doctor-mascot-container")) {
      panel.classList.add("hidden");
      panel.setAttribute("aria-hidden", "true");
      bubble.style.opacity = "";
    }
  });

  function beginDrag(clientX, clientY) {
    dragging = true;
    mascot.dataset.wasDragging = "false";
    const rect = mascot.getBoundingClientRect();
    offsetX = clientX - rect.left;
    offsetY = clientY - rect.top;
    mascot.style.cursor = "grabbing";
    mascot.style.animation = "none";
    mascot.style.transition = "none";
    for (const id of ["left-arm-idle", "right-arm", "robot-all"]) {
      const part = document.getElementById(id);
      if (part) part.style.animation = "none";
    }
  }

  function moveDrag(clientX, clientY) {
    if (!dragging) return;
    mascot.dataset.wasDragging = "true";
    const left = Math.max(0, Math.min(window.innerWidth - mascotBody.offsetWidth, clientX - offsetX));
    const top = Math.max(0, Math.min(window.innerHeight - mascotBody.offsetHeight, clientY - offsetY));
    mascot.style.left = `${left}px`;
    mascot.style.top = `${top}px`;
    mascot.style.right = "auto";
    mascot.style.bottom = "auto";
    positionPanel(left, top);
    positionBubble();
  }

  function finishDrag() {
    if (!dragging) return;
    dragging = false;
    mascot.style.cursor = "grab";
    mascot.style.animation = "mascot-bob 4s ease-in-out infinite";
    if (mascot.dataset.wasDragging === "true") {
      justDragged = true;
      setTimeout(() => {
        justDragged = false;
      }, 120);
    }
  }

  mascotBody.addEventListener("mousedown", (event) => beginDrag(event.clientX, event.clientY));
  document.addEventListener("mousemove", (event) => moveDrag(event.clientX, event.clientY));
  document.addEventListener("mouseup", finishDrag);
  mascotBody.addEventListener("touchstart", (event) => {
    const touch = event.touches[0];
    beginDrag(touch.clientX, touch.clientY);
  }, { passive: true });
  document.addEventListener("touchmove", (event) => {
    if (!dragging) return;
    const touch = event.touches[0];
    moveDrag(touch.clientX, touch.clientY);
  }, { passive: true });
  document.addEventListener("touchend", finishDrag);

  let supportEmail = "support@msob.ai";
  let activeIdentity = { role: null, firstName: "" };
  const contexts = {
    landing: {
      intro: "Bonjour ! Je peux vous aider à choisir le bon espace.",
      bubble: "Besoin d'aide pour choisir un espace ?",
      questions: [
        ["spaces", "Quelle différence entre les espaces ?", "L'espace Médecin sert à consulter les patients, gérer leur dossier médical et lancer des analyses. L'espace Administration sert à gérer les médecins, les patients, le journal d'activité et le test backend."],
        ["access", "Qui peut accéder à chaque espace ?", "Un ID médecin autorisé ouvre uniquement l'espace Médecin. Un ID administrateur autorisé ouvre uniquement l'espace Administration."],
        ["forgot", "J'ai oublié mon identifiant", `Contactez ${supportEmail}. Aucun identifiant ne peut être récupéré depuis cette page.`],
        ["privacy", "Les données patient sont-elles visibles ici ?", "Non. Aucune donnée patient n'est affichée avant l'ouverture d'un espace autorisé."],
      ],
    },
    "doctor-login": {
      intro: "Accès Médecin : utilisez votre identifiant autorisé.",
      bubble: "Une question sur l'accès Médecin ?",
      questions: [
        ["format", "Quel format pour l'identifiant ?", "L'identifiant contient 8 à 10 lettres et chiffres, avec au moins une lettre et un chiffre. Les majuscules et minuscules sont acceptées indifféremment."],
        ["forgot", "Identifiant médecin oublié", `Contactez ${supportEmail} pour faire vérifier votre accès.`],
        ["session", "Combien de temps dure la session ?", "La session Médecin expire après 30 minutes sans activité. Elle reste ouverte après actualisation tant que ce délai n'est pas dépassé, et le décompte est suspendu pendant une analyse clinique en cours."],
        ["security", "L'identifiant est-il envoyé à l'IA ?", "Non. L'identifiant sert uniquement au contrôle d'accès et aux confirmations dans l'application."],
      ],
    },
    "admin-login": {
      intro: "Accès Administration : utilisez votre identifiant administrateur.",
      bubble: "Une question sur l'administration ?",
      questions: [
        ["format", "Quel format pour l'identifiant ?", "L'identifiant contient 8 à 10 lettres et chiffres, avec au moins une lettre et un chiffre. La casse n'a pas d'importance."],
        ["forgot", "Identifiant administrateur oublié", `Contactez ${supportEmail} pour faire vérifier votre accès.`],
        ["scope", "Que permet l'administration ?", "Elle permet de gérer les médecins autorisés, les patients, leurs données associées, le journal d'activité et le test backend."],
        ["refresh", "La session Admin survit-elle à l'actualisation ?", "Non. Une actualisation ferme volontairement la session Administration et revient au choix des espaces."],
      ],
    },
    doctor: {
      intro: "Bonjour Docteur. Choisissez une question ci-dessous.",
      bubble: "Une question sur le dossier patient ?",
      questions: [
        ["analysis", "Comment lancer une analyse ?", "Sélectionnez un patient, ouvrez « Nouveau cas clinique », saisissez la description obligatoire et ajoutez éventuellement des documents. Le dossier médical enregistré est joint automatiquement."],
        ["report", "Que faire du rapport reçu ?", "Relancer réutilise exactement le même texte et les mêmes fichiers sans les redemander. Confirmer demande votre propre ID puis enregistre le rapport dans les consultations précédentes."],
        ["folder", "Comment gérer le dossier médical ?", "Ouvrez « Dossier médical » pour consulter les notes et télécharger les fichiers. « Modifier les informations » permet d'ajouter ou retirer des éléments avant confirmation avec votre ID."],
        ["session", "Quand la session expire-t-elle ?", "La session expire après 30 minutes sans activité. Une analyse clinique en cours suspend ce délai, qui repart de 30 minutes lorsqu'elle se termine. Ouvrir cet assistant réinitialise le délai ; déplacer le robot ou seulement revenir sur l'onglet ne le fait pas."],
        ["case-hassan", "Cas test : Hassan TAHIRI", "Dyspnée aiguë depuis deux jours avec orthopnée, toux productive apparue après un épisode de fausse route, prise de 2 kg en une semaine et confusion légère. Température : 37,8 °C ; tension artérielle : 142/88 mmHg ; fréquence cardiaque : 104/min, irrégulière ; fréquence respiratoire : 27/min ; SpO2 : 89 % à l'air ambiant. L'examen retrouve des crépitants bilatéraux prédominant à droite, une turgescence jugulaire et des œdèmes des membres inférieurs. Demande d'avis urgent sur l'orientation diagnostique et la prise en charge initiale."],
        ["case-salma", "Cas test : Salma AMRANI", "Aggravation depuis 24 heures d'une dyspnée initialement à l'effort, maintenant présente au repos, associée à une douleur basithoracique droite augmentée à l'inspiration, des palpitations et une toux sèche. Température : 38,1 °C ; fréquence cardiaque : 112/min ; fréquence respiratoire : 25/min ; SpO2 : 92 % à l'air ambiant. Un voyage aérien de six heures a eu lieu dix jours auparavant. Le mollet gauche est légèrement douloureux à la palpation. Demande d'avis urgent sur les diagnostics à exclure et la conduite à tenir."],
        ["case-karim", "Cas test : Karim BENNANI", "Fièvre persistante depuis dix jours avec frissons, sueurs nocturnes, asthénie, perte de 3 kg et dyspnée d'effort croissante. Température : 38,6 °C ; tension artérielle : 118/72 mmHg ; fréquence cardiaque : 98/min ; SpO2 : 95 % à l'air ambiant. L'auscultation retrouve un souffle systolique apical plus net qu'à l'habitude. De possibles pétéchies conjonctivales et une discrète splénomégalie sont notées. Des hémocultures sont en attente. Demande d'avis sur la priorité diagnostique et la prise en charge."],
      ],
    },
    admin: {
      intro: "Bonjour. Je peux vous guider dans l'espace Administration.",
      bubble: "Une question sur la gestion ?",
      questions: [
        ["doctors", "Comment gérer les médecins ?", "L'onglet Médecins permet d'ajouter, modifier ou retirer un accès. Chaque changement demande une confirmation par ID administrateur."],
        ["patients", "Comment gérer les patients ?", "L'onglet Patients permet d'ajouter ou modifier un dossier. La suppression comporte trois confirmations et efface le patient, son dossier, ses fichiers et ses consultations."],
        ["logs", "Que contient le journal ?", "Le Journal affiche les actions importantes avec leur date, l'auteur, son rôle et la personne concernée. Les libellés patient sont chiffrés dans la base."],
        ["test", "À quoi sert le test backend ?", "L'onglet Test backend utilise uniquement le webhook de test d'Omar. Il est séparé du webhook de production utilisé pour les analyses cliniques."],
      ],
    },
  };

  window.addEventListener("msob:runtime-config", (event) => {
    const nextEmail = String(event.detail?.supportEmail || "").trim();
    if (!nextEmail || nextEmail === supportEmail) return;
    for (const context of Object.values(contexts)) {
      for (const question of context.questions) {
        question[2] = String(question[2]).replaceAll(supportEmail, nextEmail);
      }
    }
    supportEmail = nextEmail;
  });

  let activeContext = document.documentElement.dataset.assistantContext || "landing";
  let typingGeneration = 0;

  function currentContext() {
    return contexts[activeContext] || contexts.landing;
  }

  function currentIntro(context) {
    const firstName = String(activeIdentity.firstName || "").trim();
    if (activeContext === "doctor" && activeIdentity.role === "doctor" && firstName) {
      return "Bonjour Dr " + firstName + ". Choisissez une question ci-dessous.";
    }
    if (activeContext === "admin" && activeIdentity.role === "admin" && firstName) {
      return "Bonjour " + firstName + ". Je peux vous guider dans l'espace Administration.";
    }
    return context.intro;
  }

  function setSuggestionsDisabled(disabled) {
    for (const button of suggestions.querySelectorAll(".suggest-btn")) button.disabled = disabled;
  }

  function renderAssistantContext(contextName) {
    activeContext = contexts[contextName] ? contextName : "landing";
    typingGeneration += 1;
    typingAnswer = false;
    const context = currentContext();
    bubble.textContent = context.bubble;
    chatLog.replaceChildren();
    const intro = document.createElement("div");
    intro.className = "assistant-msg assistant-bot";
    intro.textContent = currentIntro(context);
    chatLog.append(intro);
    suggestions.replaceChildren();
    const standardQuestions = context.questions.filter(([key]) => !String(key).startsWith("case-"));
    const testCases = context.questions.filter(([key]) => String(key).startsWith("case-"));
    const appendQuestionButton = (parent, key, question) => {
      const button = document.createElement("button");
      button.className = "suggest-btn";
      button.type = "button";
      button.dataset.q = key;
      button.textContent = question;
      parent.append(button);
    };
    for (const [key, question] of standardQuestions) {
      appendQuestionButton(suggestions, key, question);
    }
    if (testCases.length) {
      const testGroup = document.createElement("details");
      testGroup.className = "assistant-test-cases";
      const summary = document.createElement("summary");
      summary.textContent = "Cas cliniques de test (" + testCases.length + ")";
      const buttons = document.createElement("div");
      buttons.className = "assistant-test-buttons";
      for (const [key, question] of testCases) {
        appendQuestionButton(buttons, key, question);
      }
      testGroup.append(summary, buttons);
      suggestions.append(testGroup);
    }
    positionBubble();
  }

  async function typeBotAnswer(answer, generation) {
    const botMessage = document.createElement("div");
    botMessage.className = "assistant-msg assistant-bot typing";
    botMessage.setAttribute("aria-live", "polite");
    chatLog.append(botMessage);
    for (const character of answer) {
      if (generation !== typingGeneration) return;
      botMessage.textContent += character;
      chatLog.scrollTop = chatLog.scrollHeight;
      const delay = /[.!?]/.test(character) ? 55 : /[,;:]/.test(character) ? 32 : 14;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    botMessage.classList.remove("typing");
  }

  suggestions.addEventListener("click", async (event) => {
    const button = event.target.closest(".suggest-btn");
    if (!button || typingAnswer) return;
    event.stopPropagation();
    const item = currentContext().questions.find(([key]) => key === button.dataset.q);
    const answer = item?.[2];
    if (!answer) return;
    typingAnswer = true;
    setSuggestionsDisabled(true);
    window.MSOBSession?.markActivity();
    const userMessage = document.createElement("div");
    userMessage.className = "assistant-msg assistant-user";
    userMessage.textContent = button.textContent;
    chatLog.append(userMessage);
    chatLog.scrollTop = chatLog.scrollHeight;
    const generation = ++typingGeneration;
    try {
      await typeBotAnswer(answer, generation);
    } finally {
      if (generation === typingGeneration) {
        typingAnswer = false;
        setSuggestionsDisabled(false);
      }
    }
  });

  window.addEventListener("msob:assistant-context", (event) => {
    renderAssistantContext(event.detail?.context || "landing");
  });

  window.addEventListener("msob:assistant-identity", (event) => {
    activeIdentity = {
      role: event.detail?.role || null,
      firstName: String(event.detail?.firstName || "").trim(),
    };
    if (activeContext === "doctor" || activeContext === "admin") {
      renderAssistantContext(activeContext);
    }
  });

  renderAssistantContext(activeContext);

  setTimeout(() => {
    const rect = mascot.getBoundingClientRect();
    positionPanel(rect.left, rect.top);
    positionBubble();
  }, 1600);
  window.addEventListener("resize", () => {
    const rect = mascot.getBoundingClientRect();
    positionPanel(rect.left, rect.top);
    positionBubble();
  });
  window.addEventListener("msob:analysis-state", refreshCountdown);
  setInterval(refreshCountdown, 250);
  document.addEventListener("visibilitychange", refreshCountdown);
  refreshCountdown();
});
