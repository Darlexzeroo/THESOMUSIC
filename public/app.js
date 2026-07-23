const socket = io();

let player;
let playerReady = false;
let currentVideo = null;
let currentRoom = null;
const LAST_ROOM_KEY = "theso-last-room-v1";
let automaticRoomRestorePending = false;
let mySocketId = null;
let remoteAction = false;
let syncInterval = null;
let pendingRoomPlayback = null;
let userActivatedPlayback = sessionStorage.getItem("waveroom-playback-activated") === "1";
let searchProvider = "youtube";
let twitchPausedChannel = "";
let playbackRequestVersion = 0;

const $ = id => document.getElementById(id);
const username = $("username");
const toast = $("toast");
let profilePhotoData = localStorage.getItem("waveroom-photo") || "";
let profileBannerData = localStorage.getItem("waveroom-banner") || "";
const browserGuestClientId = localStorage.getItem("waveroom-client-id") || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
localStorage.setItem("waveroom-client-id", browserGuestClientId);
let persistentClientId = browserGuestClientId;

let voiceStream = null;
let voiceRawStream = null;
let voiceFilterGraph = null;
let voiceJoined = false;
let voiceMuted = false;
const voicePeers = new Map();
const voiceMutedUsers = new Map();
const voiceUserVolumes = new Map();
const voiceAnalysers = new Map();
const speakingUsers = new Set();
let voiceMeterFrame = null;
let voiceOutputVolume = Math.max(0, Math.min(100, Number(localStorage.getItem("waveroom-voice-volume") ?? 100)));
let voiceNoiseFilterEnabled = localStorage.getItem("waveroom-voice-noise-filter") !== "false";
let activePrivateUserId = null;
let activePrivateClientId = null;
let savedPrivateContacts = [];
let persistentFriends = [];
let incomingFriendRequests = [];
let outgoingFriendRequests = [];
let databaseConnected = null;
const privateUnread = new Map();
const privateMessageCache = new Map();
let privateReplyTarget = null;
let privateSearchTerm = "";
let privateTypingTimer = null;
let privateTypingSent = false;
let privateCallPeer = null;
let privateCallTargetId = null;
let incomingPrivateCallerId = null;
let privateCallActive = false;
const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ]
};

function notify(text) {
  toast.textContent = text;
  toast.classList.remove("hidden");
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => toast.classList.add("hidden"), 2500);
}

const appNotifications = [];
let unreadAppNotifications = 0;

function ensureNotificationCenter() {
  let center = document.getElementById("notificationCenter");
  if (center) return center;
  center = document.createElement("section");
  center.id = "notificationCenter";
  center.className = "notification-center hidden";
  center.innerHTML = `<header><strong>Notificaciones</strong><button id="clearNotifications" type="button">Marcar leídas</button></header><div id="notificationList" class="notification-list"></div>`;
  document.body.appendChild(center);
  center.addEventListener("click", event => event.stopPropagation());
  center.querySelector("#clearNotifications").addEventListener("click", () => {
    unreadAppNotifications = 0;
    updateNotificationBell();
    renderNotifications();
    updateDocumentTitle();
  });
  return center;
}

function updateNotificationBell() {
  const dot = document.querySelector(".notification-dot");
  const button = document.querySelector(".notification-btn");
  if (!dot) return;
  dot.textContent = unreadAppNotifications ? String(Math.min(99, unreadAppNotifications)) : "";
  dot.classList.toggle("has-count", unreadAppNotifications > 0);
  dot.classList.toggle("hidden", unreadAppNotifications === 0);
  button?.classList.toggle("has-unread-notifications", unreadAppNotifications > 0);
  if (button) {
    button.title = unreadAppNotifications > 0
      ? `${unreadAppNotifications} notificación${unreadAppNotifications === 1 ? "" : "es"} sin leer`
      : "Notificaciones";
  }
}

function renderNotifications() {
  const list = ensureNotificationCenter().querySelector("#notificationList");
  list.innerHTML = appNotifications.length ? appNotifications.map((item, index) => `
    <button class="notification-item" type="button" data-notification-index="${index}">
      <b>${item.icon || "🔔"}</b><span><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.text)}</span></span>
    </button>`).join("") : '<p class="notification-empty">Todavía no hay notificaciones.</p>';
  list.querySelectorAll("[data-notification-index]").forEach(button => button.addEventListener("click", () => {
    const item = appNotifications[Number(button.dataset.notificationIndex)];
    ensureNotificationCenter().classList.add("hidden");
    if (item?.openFriends) openFriendsModal();
    if (item?.clientId) setTimeout(() => openPrivateChatByClient(item.clientId), 80);
    else if (item?.userId) setTimeout(() => openPrivateChat(item.userId), 80);
  }));
}

function addFriendsNotification(title, text, options = {}) {
  appNotifications.unshift({ title, text, icon: options.icon || "👥", openFriends: true, userId: options.userId || null, clientId: options.clientId || null });
  if (appNotifications.length > 30) appNotifications.length = 30;
  unreadAppNotifications += 1;
  updateNotificationBell();
  renderNotifications();
  updateDocumentTitle();
}

let notificationAudioContext = null;
let notificationToastTimer = null;
const originalDocumentTitle = document.title;

function updateDocumentTitle() {
  document.title = unreadAppNotifications > 0
    ? `(${Math.min(99, unreadAppNotifications)}) ${originalDocumentTitle}`
    : originalDocumentTitle;
}

function playPrivateMessageSound() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    notificationAudioContext ||= new AudioContextClass();
    if (notificationAudioContext.state === "suspended") notificationAudioContext.resume().catch(() => {});
    const now = notificationAudioContext.currentTime;
    const oscillator = notificationAudioContext.createOscillator();
    const gain = notificationAudioContext.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(740, now);
    oscillator.frequency.exponentialRampToValueAtTime(980, now + 0.12);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.11, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.23);
    oscillator.connect(gain).connect(notificationAudioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.24);
  } catch {}
}

function ensurePrivateMessageToast() {
  let element = document.getElementById("privateMessageToast");
  if (element) return element;
  element = document.createElement("button");
  element.id = "privateMessageToast";
  element.type = "button";
  element.className = "private-message-toast hidden";
  document.body.appendChild(element);
  return element;
}

function showPrivateMessageToast(message, otherClientId) {
  const element = ensurePrivateMessageToast();
  const preview = message.text || "Envió una imagen";
  const initial = String(message.author || "U").trim().charAt(0).toUpperCase() || "U";
  element.innerHTML = `
    <span class="private-toast-avatar">${escapeHtml(initial)}</span>
    <span class="private-toast-copy"><strong>${escapeHtml(message.author || "Usuario")}</strong><span>${escapeHtml(preview)}</span></span>
    <span class="private-toast-open">Abrir</span>`;
  element.onclick = () => {
    element.classList.add("hidden");
    openFriendsModal();
    setTimeout(() => openPrivateChatByClient(otherClientId), 60);
  };
  element.classList.remove("hidden");
  clearTimeout(notificationToastTimer);
  notificationToastTimer = setTimeout(() => element.classList.add("hidden"), 6000);
}

function showNativePrivateNotification(message, otherClientId) {
  if (!("Notification" in window) || Notification.permission !== "granted" || !document.hidden) return;
  try {
    const notification = new Notification(`Mensaje de ${message.author || "Usuario"}`, {
      body: message.text || "Te envió una imagen",
      tag: `waveroom-private-${otherClientId}`,
      renotify: true,
      silent: true
    });
    notification.onclick = () => {
      window.focus();
      openFriendsModal();
      setTimeout(() => openPrivateChatByClient(otherClientId), 60);
      notification.close();
    };
    setTimeout(() => notification.close(), 9000);
  } catch {}
}

function requestBrowserNotifications() {
  if (!("Notification" in window) || Notification.permission !== "default") return;
  Notification.requestPermission().catch(() => {});
}

function setupNotificationBell() {
  const button = document.querySelector(".notification-btn");
  if (!button) return;
  ensureNotificationCenter();
  updateNotificationBell();
  button.addEventListener("click", event => {
    event.stopPropagation();
    requestBrowserNotifications();
    const center = ensureNotificationCenter();
    center.classList.toggle("hidden");
    if (!center.classList.contains("hidden")) {
      unreadAppNotifications = 0;
      updateNotificationBell();
      renderNotifications();
      updateDocumentTitle();
    }
  });
  document.addEventListener("click", () => ensureNotificationCenter().classList.add("hidden"));
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function getName() {
  return username.value.trim() || "Invitado";
}

function getProfile() {
  return { name: getName(), avatar: profilePhotoData, banner: profileBannerData, clientId: persistentClientId };
}

// Registra esta instalación del navegador en un canal persistente del servidor.
// Este registro es indispensable para que los mensajes privados lleguen en tiempo real,
// aunque el usuario no esté dentro de una sala musical.
function registerPersistentClient(callback) {
  if (!socket.connected || !persistentClientId) {
    callback?.({ ok: false, error: "Socket desconectado." });
    return;
  }

  socket.timeout(8000).emit("register-client", {
    clientId: persistentClientId,
    name: getName(),
    avatar: profilePhotoData,
    banner: profileBannerData
  }, (error, response) => {
    if (error) {
      console.warn("El servidor tardó demasiado en registrar la cuenta.");
      callback?.({ ok: false, error: "Tiempo de espera agotado al registrar la cuenta." });
      return;
    }
    if (typeof response?.database === "boolean") {
      databaseConnected = response.database;
      renderFriendsList();
    }
    if (!response?.ok) {
      console.warn("No se pudo registrar el cliente persistente:", response?.error || "Error desconocido");
    }
    if (response?.restoredRoom) {
      mySocketId = socket.id;
      renderRoom(response.restoredRoom);
      if (response.restoredRoom.video) {
        applyRoomPlayback(response.restoredRoom.video, response.restoredRoom.time || 0, response.restoredRoom.playing).catch(() => {});
      }
    } else {
      tryRestoreLastRoom();
    }
    callback?.(response);
  });
}

// Limpia toda la información que pertenece a la cuenta anterior. Los amigos,
// solicitudes, conversaciones y contadores de Discord nunca deben heredarse
// por una sesión de invitado (ni al revés).
function saveLastRoom(room) {
  if (!room?.code || !persistentClientId) return;
  try { localStorage.setItem(LAST_ROOM_KEY, JSON.stringify({ code: room.code, clientId: persistentClientId, savedAt: Date.now() })); } catch {}
}

function clearLastRoom() {
  try { localStorage.removeItem(LAST_ROOM_KEY); } catch {}
}

function tryRestoreLastRoom() {
  if (!socket.connected || currentRoom || automaticRoomRestorePending || !persistentClientId) return;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LAST_ROOM_KEY) || "null"); } catch {}
  if (!saved?.code || saved.clientId !== persistentClientId || Date.now() - Number(saved.savedAt || 0) > 24 * 60 * 60 * 1000) return;
  automaticRoomRestorePending = true;
  socket.emit("join-room", { code: saved.code, ...getProfile() }, async response => {
    automaticRoomRestorePending = false;
    if (!response?.ok) { clearLastRoom(); return; }
    mySocketId = response.socketId || socket.id;
    renderRoom(response.room);
    if (response.room?.video) {
      try { await applyRoomPlayback(response.room.video, response.room.time || 0, response.room.playing); } catch {}
    }
  });
}

function leaveRoomForAccountSwitch() {
  // Una sala pertenece a la identidad con la que se entró. Al cambiar entre
  // Discord e invitado nunca conservamos la sala anterior en pantalla ni en
  // el servidor, porque eso mostraría el perfil de la cuenta previa.
  const roomCode = currentRoom?.code;
  if (roomCode && socket.connected) {
    socket.emit("leave-room", { code: roomCode });
  }
  clearLastRoom();
  if (currentRoom) {
    resetRoomUI();
    closeRoomModal();
  }
}

function resetAccountScopedState() {
  savedPrivateContacts = [];
  persistentFriends = [];
  incomingFriendRequests = [];
  outgoingFriendRequests = [];
  databaseConnected = null;
  privateUnread.clear();
  privateMessageCache.clear();
  resetPrivateChat();
  updatePrivateUnreadBadge();

  // Las notificaciones pertenecen a la cuenta activa. Al cambiar entre
  // Discord e invitado no deben conservarse en la campana ni en el título.
  appNotifications.length = 0;
  unreadAppNotifications = 0;
  clearTimeout(notificationToastTimer);
  document.getElementById("privateMessageToast")?.classList.add("hidden");
  document.getElementById("notificationCenter")?.classList.add("hidden");
  updateNotificationBell();
  renderNotifications();
  updateDocumentTitle();

  renderFriendsList();
}

// La identidad autenticada se determina durante el handshake de Socket.IO.
// Cuando se cambia entre Discord e invitado hay que abrir una conexión nueva
// para que el servidor vuelva a leer la cookie de sesión actual.
function registerIdentityAfterAccountSwitch(previousMode) {
  const changedAccountType = Boolean(previousMode && previousMode !== activeLoginMode);
  if (changedAccountType && socket.connected) {
    socket.disconnect();
    socket.connect();
    return;
  }
  registerPersistentClient(() => {
    loadFriendState();
    loadPrivateConversations();
  });
}

function applyAvatar(element, name = getName(), avatar = profilePhotoData) {
  if (!element) return;
  element.textContent = avatar ? "" : (name[0]?.toUpperCase() || "?");
  if (avatar) {
    element.style.setProperty("background-image", `url("${avatar}")`, "important");
    element.style.backgroundColor = "transparent";
    element.dataset.hasAvatar = "true";
  } else {
    element.style.removeProperty("background-image");
    element.style.removeProperty("background-color");
    delete element.dataset.hasAvatar;
  }
}

function applyProfileBanner(element, banner = profileBannerData) {
  if (!element) return;
  element.style.backgroundImage = banner ? `url("${banner}")` : "";
  element.classList.toggle("has-image", Boolean(banner));
}

function refreshProfileUI() {
  $("profileName").textContent = getName();
  if ($("miniProfileName")) $("miniProfileName").textContent = getName();
  if ($("profilePreviewName")) $("profilePreviewName").textContent = getName();
  applyAvatar($("avatar"));
  applyAvatar($("miniAvatar"));
  applyProfileBanner($("miniProfileBanner"));
  applyAvatar($("profilePreview"));
  applyProfileBanner($("profileBannerPreview"));
  applyProfileBanner($("profileCardBanner"));
  document.documentElement.style.setProperty("--profile-banner-image", profileBannerData ? `url("${profileBannerData}")` : "none");
}


function updatePlayerDockVisibility() {
  // El reproductor inferior solo debe ocupar espacio cuando el usuario está
  // dentro de una sala y existe una canción/directo activo.
  const shouldShow = Boolean(currentRoom && currentVideo?.id);
  const dock = $("playerDock");
  dock?.classList.toggle("hidden", !shouldShow);
  dock?.setAttribute("aria-hidden", shouldShow ? "false" : "true");
  document.body.classList.toggle("player-dock-hidden", !shouldShow);
}

function updateTrackUI(video) {
  const hasTrack = Boolean(video?.id);
  document.body.classList.toggle("has-track", hasTrack);
  document.body.classList.toggle("is-idle", !hasTrack);
  updatePlayerDockVisibility();

  if (!hasTrack) {
    $("nowPlaying").textContent = "Ninguna canción";
    $("trackChannel").textContent = "--";
    $("trackCover").style.backgroundImage = "";
    $("trackCover").textContent = "♫";
    $("videoStageTitle").textContent = "Canción";
    return;
  }

  $("nowPlaying").textContent = video.title || "Video de YouTube";
  $("trackChannel").textContent = video.channel || "YouTube";
  $("videoStageTitle").textContent = video.title || "Video de YouTube";
  const thumb = video.thumbnail || (video.provider === "twitch" ? "" : `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`);
  $("trackCover").style.backgroundImage = `url("${thumb}")`;
  $("trackCover").textContent = "";
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${rest}`;
}



const EMOTES = ["😀","😂","😍","😎","😭","😡","🥳","🤔","👍","👎","❤️","🔥","🎉","💀","👀","🙏","🎵","🎧","🎤","✨","🚀","🫡","😴","🤡"];
const CUSTOM_EMOTES_KEY = "theso_custom_emotes_v1";

function getCustomEmotes() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_EMOTES_KEY) || "[]").filter(item => item?.data).slice(0, 24); }
  catch { return []; }
}

function saveCustomEmotes(items) {
  try { localStorage.setItem(CUSTOM_EMOTES_KEY, JSON.stringify(items.slice(0, 24))); }
  catch { notify("No hay espacio para guardar más emotes personalizados."); }
}

async function prepareCustomEmote(file) {
  const allowed = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  if (!file || !allowed.includes(file.type)) throw new Error("Usa PNG, JPG, WEBP o GIF.");
  if (file.size > 2 * 1024 * 1024) throw new Error("El emote no puede superar 2 MB.");
  if (file.type === "image/gif") return { data: await readFileDataUrl(file), name: file.name };
  const source = await readFileDataUrl(file);
  const image = await new Promise((resolve, reject) => {
    const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = source;
  });
  const canvas = document.createElement("canvas");
  canvas.width = 128; canvas.height = 128;
  const ctx = canvas.getContext("2d");
  const scale = Math.max(128 / image.naturalWidth, 128 / image.naturalHeight);
  const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
  ctx.drawImage(image, (128 - width) / 2, (128 - height) / 2, width, height);
  return { data: canvas.toDataURL("image/webp", .82), name: file.name.replace(/\.[^.]+$/, ".webp") };
}

function sendCustomEmote(emote, mode) {
  if (mode === "private") {
    if (!activePrivateClientId) return notify("Selecciona una conversación privada.");
    socket.emit("private-chat-global", { clientId: persistentClientId, targetClientId: activePrivateClientId, text: "", image: emote }, response => {
      if (!response?.ok) notify(response?.error || "No se pudo enviar el emote.");
    });
    return;
  }
  if (!currentRoom) return notify("Primero entra a una sala.");
  socket.emit("chat", { code: currentRoom.code, text: "", image: emote }, response => {
    if (!response?.ok) notify(response?.error || "No se pudo enviar el emote.");
  });
}

function setupEmojiPicker(buttonId, pickerId, inputId, mode = "room") {
  const button = $(buttonId);
  const picker = $(pickerId);
  const input = $(inputId);
  if (!button || !picker || !input) return;

  const renderPicker = () => {
    const customs = getCustomEmotes();
    picker.innerHTML = `
      <div class="emoji-picker-scroll">
        ${EMOTES.map(e => `<button type="button" data-emote="${e}">${e}</button>`).join("")}
        ${customs.map((e, index) => `<button type="button" class="custom-emote-btn" data-custom-emote="${index}" title="${escapeHtml(e.name || "Emote personalizado")}"><img src="${escapeHtml(e.data)}" alt=""></button>`).join("")}
        <button type="button" class="add-custom-emote" data-add-custom-emote title="Agregar emote personalizado">＋</button>
      </div>
      <input class="custom-emote-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
      <small class="emoji-picker-help">Tus emotes se guardan en este navegador.</small>`;
  };
  renderPicker();

  button.addEventListener("click", event => {
    event.stopPropagation();
    renderPicker();
    picker.classList.toggle("hidden");
  });
  picker.addEventListener("click", event => {
    const emote = event.target.closest("[data-emote]")?.dataset.emote;
    if (emote) {
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      input.value = input.value.slice(0, start) + emote + input.value.slice(end);
      picker.classList.add("hidden");
      input.focus();
      input.setSelectionRange(start + emote.length, start + emote.length);
      return;
    }
    const customButton = event.target.closest("[data-custom-emote]");
    if (customButton) {
      const custom = getCustomEmotes()[Number(customButton.dataset.customEmote)];
      if (custom) sendCustomEmote(custom, mode);
      picker.classList.add("hidden");
      return;
    }
    if (event.target.closest("[data-add-custom-emote]")) picker.querySelector(".custom-emote-input")?.click();
  });
  picker.addEventListener("change", async event => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const emote = await prepareCustomEmote(file);
      const items = getCustomEmotes();
      items.push(emote);
      saveCustomEmotes(items);
      renderPicker();
      notify("Emote personalizado agregado.");
    } catch (error) { notify(error.message || "No se pudo agregar el emote."); }
  });
  document.addEventListener("click", event => {
    if (!picker.contains(event.target) && event.target !== button) picker.classList.add("hidden");
  });
}

async function ensureVoiceStream() {
  if (voiceStream) return voiceStream;
  voiceRawStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: voiceNoiseFilterEnabled, noiseSuppression: voiceNoiseFilterEnabled, autoGainControl: voiceNoiseFilterEnabled, channelCount: 1, sampleRate: { ideal: 48000 }, sampleSize: { ideal: 24 }, latency: { ideal: 0.02 } },
    video: false
  });
  voiceStream = await createEnhancedVoiceStream(voiceRawStream, voiceNoiseFilterEnabled);
  return voiceStream;
}

function updatePrivateCallPanel(active = privateCallActive, text = $("privateCallStatus")?.textContent || "Chat privado") {
  const widget = document.querySelector(".private-call-widget");
  const name = $("privateChatName")?.textContent || "Usuario";
  const initial = (name.trim()[0] || "?").toUpperCase();
  widget?.classList.toggle("is-active", Boolean(active));
  $("privateCallLiveDot")?.classList.toggle("active", Boolean(active));
  if ($("privateCallPanelTitle")) $("privateCallPanelTitle").textContent = active ? "Llamada privada" : "Sin llamada activa";
  if ($("privateCallPanelStatus")) $("privateCallPanelStatus").textContent = text;
  if ($("privateCallPanelName")) $("privateCallPanelName").textContent = active ? name : "Llamadas uno a uno";
  if ($("privateCallPanelAvatar")) $("privateCallPanelAvatar").textContent = active ? initial : "☎";
  if ($("privateCallPanelHint")) $("privateCallPanelHint").textContent = active ? "La llamada es privada entre ustedes dos." : "Aquí aparecerán los controles cuando estés en una llamada privada.";
  if ($("privateCallPanelMute")) $("privateCallPanelMute").disabled = !active;
  if ($("privateCallPanelHangup")) $("privateCallPanelHangup").disabled = !active;
}

function setPrivateCallUi(active, text = "Chat privado") {
  privateCallActive = active;
  $("privateCallBtn").classList.toggle("hidden", active);
  $("privateHangupBtn").classList.toggle("hidden", !active);
  $("privateCallStatus").textContent = text;
  updatePrivateCallPanel(active, text);
}

function closePrivateCallPeer() {
  try { privateCallPeer?.close(); } catch {}
  privateCallPeer = null;
  document.getElementById("private-call-audio")?.remove();
}

function createPrivateCallPeer(targetId) {
  closePrivateCallPeer();
  const peer = new RTCPeerConnection(rtcConfig);
  privateCallPeer = peer;
  voiceStream?.getTracks().forEach(track => peer.addTrack(track, voiceStream));
  peer.onicecandidate = event => {
    if (event.candidate && currentRoom && privateCallTargetId) socket.emit("private-call-signal", { code: currentRoom.code, target: privateCallTargetId, data: { type: "candidate", candidate: event.candidate } });
  };
  peer.ontrack = event => {
    let audio = document.getElementById("private-call-audio");
    if (!audio) { audio = document.createElement("audio"); audio.id = "private-call-audio"; audio.autoplay = true; audio.playsInline = true; $("remoteAudios").appendChild(audio); }
    audio.srcObject = event.streams[0];
    audio.volume = voiceOutputVolume / 100;
    audio.play().catch(() => notify("Toca la pantalla para activar el audio."));
  };
  peer.onconnectionstatechange = () => {
    if (["failed","closed","disconnected"].includes(peer.connectionState)) endPrivateCall(false);
  };
  return peer;
}

async function startPrivateCall() {
  if (!currentRoom || !activePrivateUserId) return notify("Selecciona una persona.");
  if (voiceJoined) { leaveVoiceChat(true); notify("Saliste de la llamada grupal para iniciar la privada."); }
  try {
    await ensureVoiceStream();
    privateCallTargetId = activePrivateUserId;
    setPrivateCallUi(true, "Llamando...");
    socket.emit("private-call-invite", { code: currentRoom.code, target: privateCallTargetId }, response => {
      if (!response?.ok) { endPrivateCall(false); notify(response?.error || "No se pudo llamar."); }
    });
  } catch { notify("Debes permitir el micrófono."); setPrivateCallUi(false); }
}

async function acceptPrivateCallInvite() {
  if (!incomingPrivateCallerId || !currentRoom) return;
  if (voiceJoined) leaveVoiceChat(true);
  try {
    await ensureVoiceStream();
    privateCallTargetId = incomingPrivateCallerId;
    incomingPrivateCallerId = null;
    $("incomingPrivateCall").classList.add("hidden");
    setPrivateCallUi(true, "Conectando llamada privada...");
    createPrivateCallPeer(privateCallTargetId);
    socket.emit("private-call-response", { code: currentRoom.code, target: privateCallTargetId, accepted: true });
  } catch { notify("No se pudo activar el micrófono."); }
}

function rejectPrivateCallInvite() {
  if (incomingPrivateCallerId && currentRoom) socket.emit("private-call-response", { code: currentRoom.code, target: incomingPrivateCallerId, accepted: false });
  incomingPrivateCallerId = null;
  $("incomingPrivateCall").classList.add("hidden");
}

function endPrivateCall(notifyServer = true) {
  if (notifyServer && currentRoom && privateCallTargetId) socket.emit("private-call-end", { code: currentRoom.code, target: privateCallTargetId });
  closePrivateCallPeer();
  privateCallTargetId = null;
  voiceMuted = false;
  if ($("privateCallPanelMute")) $("privateCallPanelMute").textContent = "🔇 Silenciar";
  setPrivateCallUi(false, "Chat privado");
  if (!voiceJoined) { voiceStream?.getTracks().forEach(t => t.stop()); voiceRawStream?.getTracks().forEach(t => t.stop()); closeVoiceFilterGraph(); voiceStream = null; voiceRawStream = null; }
}

function openRoomModal() {
  document.body.classList.remove("mobile-menu-open");
  $("sidebarBackdrop")?.classList.add("hidden");
  $("mobileMenuBtn")?.setAttribute("aria-expanded", "false");
  $("roomModal").classList.remove("hidden");
  document.body.classList.add("modal-open", "room-open");
  document.documentElement.classList.add("room-open");
  requestAnimationFrame(() => scrollRoomMessages(true));
}

function closeRoomModal() {
  $("roomModal").classList.add("hidden");
  document.body.classList.remove("modal-open", "room-open");
  document.documentElement.classList.remove("room-open");
}

function openFriendsModal() {
  if (!requireDiscordSocial("Los invitados solo pueden escribir en el chat de las salas. Inicia sesión con Discord para usar amigos y chats privados.")) return;
  document.body.classList.remove("mobile-menu-open");
  $("sidebarBackdrop")?.classList.add("hidden");
  $("mobileMenuBtn")?.setAttribute("aria-expanded", "false");
  $("friendsModal").classList.remove("hidden");
  document.body.classList.add("modal-open", "friends-open");
  document.documentElement.classList.add("friends-open");
  loadPrivateConversations();
  renderFriendsList();
}

function closeFriendsModal() {
  if (privateCallTargetId || privateCallActive) endPrivateCall(true);
  rejectPrivateCallInvite();
  $("friendsModal").classList.add("hidden");
  document.body.classList.remove("modal-open", "friends-open");
  document.documentElement.classList.remove("friends-open");
}

function updatePrivateUnreadBadge() {
  const total = [...privateUnread.values()].reduce((sum, value) => sum + value, 0);
  const badge = $("privateUnreadBadge");
  const friendsButton = $("friendsShortcut");
  if (!badge) return;

  // En "Amigos" se muestra solamente un punto verde, no un número.
  badge.textContent = "";
  badge.classList.toggle("hidden", total === 0);
  badge.setAttribute("aria-label", total > 0 ? `${total} mensaje${total === 1 ? "" : "s"} privado${total === 1 ? "" : "s"} sin leer` : "");

  if (friendsButton) {
    friendsButton.classList.toggle("has-private-unread", total > 0);
    friendsButton.title = total > 0
      ? `${total} mensaje${total === 1 ? "" : "s"} privado${total === 1 ? "" : "s"} sin leer`
      : "Amigos";
  }
}

function getRoomUser(id) {
  return currentRoom?.users?.find(user => user.id === id) || null;
}

function requireDiscordSocial(message = "Inicia sesión con Discord para usar amigos y mensajes privados.") {
  if (activeLoginMode === "discord") return true;
  notify(message);
  return false;
}

function sendFriendRequest(targetClientId) {
  if (activeLoginMode !== "discord") return notify("Inicia sesión con Discord para agregar amigos.");
  socket.emit("friend-request-send", { targetClientId }, response => {
    if (!response?.ok) return notify(response?.error || "No se pudo enviar la solicitud.");
    notify(response.message || "Solicitud de amistad enviada.");
    loadFriendState();
  });
}

function respondFriendRequest(requestId, accept) {
  socket.emit("friend-request-respond", { requestId, accept }, response => {
    if (!response?.ok) return notify(response?.error || "No se pudo responder la solicitud.");
    notify(accept ? "Solicitud aceptada." : "Solicitud rechazada.");
    loadFriendState();
    loadFriendState();
    loadPrivateConversations();
  });
}

async function refreshDatabaseStatus() {
  if (activeLoginMode !== "discord") {
    databaseConnected = null;
    return null;
  }
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    const response = await fetch("/api/database/status", { cache: "no-store", signal: controller.signal });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const status = await response.json();
    databaseConnected = status?.connected === true;
  } catch (error) {
    console.warn("No se pudo consultar el estado de MongoDB:", error);
    // Un fallo de red del navegador no demuestra que MongoDB esté desconectado.
    databaseConnected = null;
  }
  renderFriendsList();
  return databaseConnected;
}

function loadFriendState() {
  if (!socket.connected || activeLoginMode !== "discord") {
    persistentFriends = [];
    incomingFriendRequests = [];
    outgoingFriendRequests = [];
    databaseConnected = null;
    renderFriendsList();
    return;
  }

  // Se consulta el endpoint real de estado para evitar mostrar un falso
  // "MongoDB desconectado" cuando únicamente falla la carga de amigos.
  refreshDatabaseStatus();

  socket.timeout(8000).emit("friend-state", {}, (error, response) => {
    if (error) {
      console.warn("El servidor tardó demasiado en cargar amigos y solicitudes.");
      // No dejamos la interfaz atrapada para siempre en “Comprobando…”.
      if (databaseConnected === null) databaseConnected = true;
      renderFriendsList();
      return;
    }
    if (typeof response?.database === "boolean") {
      databaseConnected = response.database;
    }
    if (!response?.ok) {
      console.warn("No se pudo cargar el estado de amigos:", response?.error || "Error desconocido");
      renderFriendsList();
      return;
    }
    persistentFriends = response.friends || [];
    incomingFriendRequests = response.incoming || [];
    outgoingFriendRequests = response.outgoing || [];
    renderFriendsList();
  });
}

function presenceDisplay(user = {}) {
  const presence = user.presence || (user.online ? "online" : "offline");
  const states = {
    online: { icon: "🟢", label: "En línea" },
    away: { icon: "🌙", label: "Ausente" },
    music: { icon: "🎵", label: "Escuchando música" },
    twitch: { icon: "🔴", label: "Viendo Twitch" },
    room: { icon: "🎧", label: "En una sala" },
    offline: { icon: "⚫", label: "Desconectado" }
  };
  const state = states[presence] || states.offline;
  return { presence, icon: state.icon, label: user.presenceLabel || state.label };
}

function renderFriendsList() {
  const roomUsers = (currentRoom?.users || []).filter(user => user.id !== mySocketId).map(user => ({
    socketId: user.id,
    clientId: user.clientId || user.id,
    name: user.name,
    avatar: user.avatar || "",
    online: true,
    inRoom: true,
    host: user.id === currentRoom?.hostId
  }));
  const merged = new Map();
  [...savedPrivateContacts, ...persistentFriends].forEach(contact => merged.set(contact.clientId, { ...contact, socketId: contact.socketId || null, inRoom: false }));
  roomUsers.forEach(user => merged.set(user.clientId, { ...(merged.get(user.clientId) || {}), ...user }));
  const friendIds = new Set(persistentFriends.map(friend => friend.clientId));
  const users = activeLoginMode === "discord"
    ? [...merged.values()].filter(user => user.clientId && user.clientId !== persistentClientId && friendIds.has(user.clientId))
    : [];
  $("friendsCount").textContent = users.length;

  const incomingHtml = incomingFriendRequests.length ? `<section class="friend-request-section"><strong>Solicitudes recibidas</strong>${incomingFriendRequests.map(user => `
    <div class="friend-row friend-request-row">
      <span class="person-icon" style="${user.avatar ? `background-image:url('${escapeHtml(user.avatar)}')` : ""}">${user.avatar ? "" : escapeHtml(user.name?.[0]?.toUpperCase() || "?")}</span>
      <span><strong>${escapeHtml(user.name || "Usuario")}</strong><small>Quiere agregarte</small></span>
      <span class="friend-request-actions"><button type="button" data-request-accept="${escapeHtml(user.requestId)}">✓</button><button type="button" data-request-reject="${escapeHtml(user.requestId)}">×</button></span>
    </div>`).join("")}</section>` : "";

  const outgoingHtml = outgoingFriendRequests.length ? `<section class="friend-request-section"><strong>Solicitudes enviadas</strong>${outgoingFriendRequests.map(user => `
    <div class="friend-row friend-request-row pending">
      <span class="person-icon" style="${user.avatar ? `background-image:url('${escapeHtml(user.avatar)}')` : ""}">${user.avatar ? "" : escapeHtml(user.name?.[0]?.toUpperCase() || "?")}</span>
      <span><strong>${escapeHtml(user.name || "Usuario")}</strong><small>Pendiente</small></span>
    </div>`).join("")}</section>` : "";

  const friendsHtml = users.length ? `<section class="friend-request-section"><strong>${activeLoginMode === "discord" ? "Amigos" : "Conversaciones temporales"}</strong>${users.map(user => {
    const unread = privateUnread.get(user.clientId) || 0;
    const selected = activePrivateClientId === user.clientId;
    const state = presenceDisplay(user);
    return `<button class="friend-row${selected ? " active" : ""}" type="button" data-friend-client="${escapeHtml(user.clientId)}">
      <span class="person-icon" style="${user.avatar ? `background-image:url('${escapeHtml(user.avatar)}')` : ""}">${user.avatar ? "" : escapeHtml(user.name?.[0]?.toUpperCase() || "?")}</span>
      <span><strong>${escapeHtml(user.name || "Usuario")}</strong><small class="presence-label presence-${escapeHtml(state.presence)}"><span class="presence-icon" aria-hidden="true">${state.icon}</span>${escapeHtml(state.label)}</small></span>
      ${unread ? `<b class="friend-unread">${unread > 99 ? "99+" : unread}</b>` : ""}
    </button>`;
  }).join("")}</section>` : "";

  const loginHint = activeLoginMode !== "discord"
    ? '<p class="friends-empty">Los invitados solo pueden escribir en los chats de las salas. Inicia sesión con Discord para enviar solicitudes y mensajes privados.</p>'
    : (databaseConnected === false
      ? '<p class="friends-empty">No se pudo conectar con MongoDB Atlas. Revisa los logs de Render.</p>'
      : (databaseConnected === null
        ? '<p class="friends-empty">Comprobando conexión con MongoDB Atlas…</p>'
        : ""));

  $("friendsList").innerHTML = incomingHtml + outgoingHtml + friendsHtml + loginHint || '<p class="friends-empty">Aún no tienes amigos. Agrégalos desde una sala.</p>';
  $("friendsList").querySelectorAll("[data-friend-client]").forEach(button => button.addEventListener("click", () => openPrivateChatByClient(button.dataset.friendClient)));
  $("friendsList").querySelectorAll("[data-request-accept]").forEach(button => button.addEventListener("click", () => respondFriendRequest(button.dataset.requestAccept, true)));
  $("friendsList").querySelectorAll("[data-request-reject]").forEach(button => button.addEventListener("click", () => respondFriendRequest(button.dataset.requestReject, false)));
}

function mergePrivateMessages(clientId, messages = []) {
  if (!clientId) return [];
  const current = privateMessageCache.get(clientId) || [];
  const merged = new Map();
  [...current, ...messages].forEach(message => {
    if (!message) return;
    const key = message.id || `${message.fromClientId || message.from || ""}-${message.createdAt || ""}-${message.text || ""}-${message.image || ""}`;
    merged.set(key, message);
  });
  const sorted = [...merged.values()].sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0)).slice(-150);
  privateMessageCache.set(clientId, sorted);
  return sorted;
}

function loadPrivateConversations(callback) {
  if (activeLoginMode !== "discord") {
    savedPrivateContacts = [];
    persistentFriends = [];
    incomingFriendRequests = [];
    outgoingFriendRequests = [];
    renderFriendsList();
    callback?.({ ok: false, error: "Los invitados no tienen conversaciones privadas." });
    return;
  }
  if (!socket.connected) {
    renderFriendsList();
    callback?.({ ok: false, error: "Socket desconectado." });
    return;
  }

  socket.emit("private-conversations", { clientId: persistentClientId }, response => {
    if (!response?.ok) {
      console.warn("No se pudieron cargar las conversaciones privadas:", response?.error || "Error desconocido");
      renderFriendsList();
      callback?.(response);
      return;
    }

    // La respuesta corresponde exclusivamente a la identidad actualmente
    // registrada. Se reemplaza la lista completa para no mezclar contactos de
    // una cuenta Discord anterior con los contactos temporales del invitado.
    const currentContacts = new Map();
    (response.contacts || []).forEach(contact => {
      if (!contact?.clientId || contact.clientId === persistentClientId) return;
      currentContacts.set(contact.clientId, { ...contact });
    });
    savedPrivateContacts = [...currentContacts.values()];
    renderFriendsList();
    callback?.(response);
  });
}

function formatPrivateDay(value) {
  const date = new Date(value || Date.now());
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Hoy";
  if (date.toDateString() === yesterday.toDateString()) return "Ayer";
  return date.toLocaleDateString([], { day: "2-digit", month: "long", year: date.getFullYear() !== today.getFullYear() ? "numeric" : undefined });
}

function setPrivateReply(message) {
  privateReplyTarget = message || null;
  const bar = $("privateReplyBar");
  if (!bar) return;
  bar.classList.toggle("hidden", !privateReplyTarget);
  $("privateReplyPreview").textContent = privateReplyTarget ? (privateReplyTarget.text || (privateReplyTarget.image ? "Imagen" : "Mensaje")) : "";
  if (privateReplyTarget) $("privateChatInput").focus();
}

function updateCachedPrivateMessage(message) {
  if (!message?.id) return;
  const otherId = message.fromClientId === persistentClientId ? message.toClientId : message.fromClientId;
  const list = privateMessageCache.get(otherId) || [];
  const index = list.findIndex(item => item.id === message.id);
  if (index >= 0) list[index] = { ...list[index], ...message };
  else list.push(message);
  privateMessageCache.set(otherId, list);
  if (activePrivateClientId === otherId) renderPrivateMessages(list);
}

function renderPrivateMessages(messages = []) {
  const box = $("privateMessages");
  const term = privateSearchTerm.trim().toLowerCase();
  const filtered = term ? messages.filter(message => String(message.text || "").toLowerCase().includes(term)) : messages;
  let lastDay = "";
  box.innerHTML = filtered.length ? filtered.map(message => {
    const mine = message.fromClientId ? message.fromClientId === persistentClientId : message.from === mySocketId;
    const time = new Date(message.createdAt || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const day = formatPrivateDay(message.createdAt);
    const separator = day !== lastDay ? `<div class="private-day-separator"><span>${escapeHtml(day)}</span></div>` : "";
    lastDay = day;
    const reply = message.replyTo ? `<div class="private-reply-quote"><b>${message.replyTo.fromClientId === persistentClientId ? "Tú" : "Mensaje"}</b><span>${escapeHtml(message.replyTo.text || "Mensaje")}</span></div>` : "";
    const reactions = Object.entries(message.reactions || {}).map(([emoji, users]) => `<button type="button" class="private-reaction${(users || []).includes(persistentClientId) ? " mine" : ""}" data-react-message="${escapeHtml(message.id)}" data-react-emoji="${escapeHtml(emoji)}">${escapeHtml(emoji)} <b>${(users || []).length}</b></button>`).join("");
    const inviteCard = message.messageType === "room_invite" && message.invite ? `<div class="private-room-invite"><b>✉ ${escapeHtml(message.text || "Invitación a sala")}</b><small>${message.invite.visibility === "private" ? "Sala privada" : "Sala pública"}</small><button type="button" data-join-invite="${escapeHtml(message.invite.code || "")}">Unirse</button></div>` : "";
    const body = message.deletedAt ? '<p class="private-message-deleted">Mensaje eliminado</p>' : `${inviteCard || (message.text ? `<p>${escapeHtml(message.text)}</p>` : "")}${imageMessageHtml(message.image)}`;
    const actions = message.deletedAt ? "" : `<div class="private-message-actions"><button type="button" data-reply-message="${escapeHtml(message.id)}" title="Responder">↩</button><button type="button" data-quick-react="${escapeHtml(message.id)}" title="Reaccionar">😊</button>${mine ? `<button type="button" data-edit-message="${escapeHtml(message.id)}" title="Editar">✎</button><button type="button" data-delete-message="${escapeHtml(message.id)}" title="Eliminar">🗑</button>` : ""}</div>`;
    return `${separator}<div class="private-message ${mine ? "mine" : "theirs"}" data-message-id="${escapeHtml(message.id || "")}">${reply}${body}<div class="private-message-meta"><small>${time}${message.editedAt ? " · editado" : ""}</small></div>${reactions ? `<div class="private-reactions">${reactions}</div>` : ""}${actions}</div>`;
  }).join("") : `<p class="private-chat-hint">${term ? "No se encontraron mensajes." : "Todavía no hay mensajes. Envía el primero."}</p>`;
  bindChatImages(box);
  box.querySelectorAll("[data-reply-message]").forEach(button => button.onclick = () => setPrivateReply(messages.find(m => m.id === button.dataset.replyMessage)));
  box.querySelectorAll("[data-quick-react]").forEach(button => button.onclick = () => socket.emit("private-message-react", { targetClientId: activePrivateClientId, messageId: button.dataset.quickReact, emoji: "❤️" }));
  box.querySelectorAll("[data-react-message]").forEach(button => button.onclick = () => socket.emit("private-message-react", { targetClientId: activePrivateClientId, messageId: button.dataset.reactMessage, emoji: button.dataset.reactEmoji }));
  box.querySelectorAll("[data-edit-message]").forEach(button => button.onclick = () => {
    const message = messages.find(m => m.id === button.dataset.editMessage);
    const text = prompt("Editar mensaje:", message?.text || "");
    if (text !== null && text.trim()) socket.emit("private-message-edit", { targetClientId: activePrivateClientId, messageId: button.dataset.editMessage, text }, response => { if (!response?.ok) notify(response?.error || "No se pudo editar."); });
  });
  box.querySelectorAll("[data-join-invite]").forEach(button => button.onclick = () => {
    const code = button.dataset.joinInvite;
    if (!code) return;
    if (currentRoom) return notify("Primero sal de tu sala actual.");
    if ($("roomCodeInput")) $("roomCodeInput").value = code;
    $("joinRoom")?.click();
  });
  box.querySelectorAll("[data-delete-message]").forEach(button => button.onclick = () => {
    if (confirm("¿Eliminar este mensaje?")) socket.emit("private-message-delete", { targetClientId: activePrivateClientId, messageId: button.dataset.deleteMessage }, response => { if (!response?.ok) notify(response?.error || "No se pudo eliminar."); });
  });
  if (!term) box.scrollTop = box.scrollHeight;
}

function openPrivateChatByClient(clientId) {
  if (!requireDiscordSocial("Los chats privados requieren iniciar sesión con Discord.")) return;
  const roomUser = currentRoom?.users?.find(user => (user.clientId || user.id) === clientId);
  const saved = savedPrivateContacts.find(user => user.clientId === clientId);
  const user = roomUser ? { ...roomUser, socketId: roomUser.id, clientId: roomUser.clientId || roomUser.id, online: true } : saved;
  if (!user || clientId === persistentClientId) return;

  activePrivateClientId = clientId;
  activePrivateUserId = user.socketId || null;
  privateUnread.delete(clientId);
  updatePrivateUnreadBadge();
  renderFriendsList();
  $("privateChatEmpty").classList.add("hidden");
  $("privateChatActive").classList.remove("hidden");
  $("privateChatName").textContent = user.name || "Usuario";
  $("privateCallBtn").disabled = !activePrivateUserId || !currentRoom;
  $("privateCallBtn").title = activePrivateUserId && currentRoom ? "Llamar en privado" : "La llamada requiere que ambos estén en la misma sala";
  if ($("inviteToRoomBtn")) {
    $("inviteToRoomBtn").disabled = !activePrivateClientId || !currentRoom;
    $("inviteToRoomBtn").title = currentRoom ? "Invitar a esta persona a tu sala" : "Entra o crea una sala para invitar";
  }
  $("privateCallStatus").textContent = activePrivateUserId && currentRoom ? "Chat privado · Disponible para llamada" : "Chat privado guardado";
  updatePrivateCallPanel(privateCallActive, $("privateCallStatus").textContent);
  const avatar = $("privateChatAvatar");
  avatar.textContent = user.avatar ? "" : (user.name?.[0]?.toUpperCase() || "?");
  avatar.style.backgroundImage = user.avatar ? `url("${user.avatar}")` : "";
  const cachedMessages = privateMessageCache.get(clientId) || [];
  renderPrivateMessages(cachedMessages);

  socket.emit("private-chat-history-global", { clientId: persistentClientId, targetClientId: clientId }, response => {
    if (!response?.ok || activePrivateClientId !== clientId) return;
    const messages = mergePrivateMessages(clientId, response.messages || []);
    renderPrivateMessages(messages);
    socket.emit("private-message-read", { targetClientId: clientId });
    $("privateChatInput").focus();
  });
}

function openPrivateChat(userId) {
  const user = getRoomUser(userId);
  if (user) openPrivateChatByClient(user.clientId || user.id);
}

function resetPrivateChat() {
  activePrivateUserId = null;
  activePrivateClientId = null;
  $("privateChatEmpty").classList.remove("hidden");
  $("privateChatActive").classList.add("hidden");
  $("privateMessages").innerHTML = "";
  privateSearchTerm = "";
  privateReplyTarget = null;
  if ($("privateChatSearch")) $("privateChatSearch").value = "";
  $("privateReplyBar")?.classList.add("hidden");
  $("privateTypingIndicator")?.classList.add("hidden");
  renderFriendsList();
}

function selectSettingsTab(tab = "profile") {
  const selected = tab === "theme" ? "theme" : "profile";
  document.querySelectorAll("[data-settings-tab]").forEach(button => {
    const active = button.dataset.settingsTab === selected;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll("[data-settings-panel]").forEach(panel => {
    panel.classList.toggle("active", panel.dataset.settingsPanel === selected);
  });
}

document.querySelectorAll("[data-settings-tab]").forEach(button => {
  button.addEventListener("click", () => selectSettingsTab(button.dataset.settingsTab));
});

function openProfileModal(tab = "profile") {
  document.body.classList.remove("mobile-menu-open");
  $("sidebarBackdrop")?.classList.add("hidden");
  $("mobileMenuBtn")?.setAttribute("aria-expanded", "false");
  $("profileModal").classList.remove("hidden");
  document.body.classList.add("modal-open");
  username.focus();
}

function closeProfileModal() {
  $("profileModal").classList.add("hidden");
  document.body.classList.remove("modal-open");
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("No se pudo leer la imagen."));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

async function prepareProfileImage(file, type = "avatar") {
  const allowed = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  if (!allowed.includes(file.type)) throw new Error("Formato no compatible. Usa JPG, PNG, WEBP o GIF.");
  if (file.size > 5 * 1024 * 1024) throw new Error("La imagen debe pesar menos de 5 MB.");

  // Los GIF se conservan sin pasarlos por canvas para no perder la animación.
  if (file.type === "image/gif") return readFileAsDataURL(file);

  const dataUrl = await readFileAsDataURL(file);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error("La imagen no es válida."));
    image.onload = () => {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) return reject(new Error("No se pudo procesar la imagen."));

      if (type === "banner") {
        canvas.width = 900;
        canvas.height = 360;
        const targetRatio = canvas.width / canvas.height;
        const imageRatio = image.width / image.height;
        let sx = 0, sy = 0, sw = image.width, sh = image.height;
        if (imageRatio > targetRatio) {
          sw = image.height * targetRatio;
          sx = (image.width - sw) / 2;
        } else {
          sh = image.width / targetRatio;
          sy = (image.height - sh) / 2;
        }
        context.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      } else {
        const size = 320;
        canvas.width = size;
        canvas.height = size;
        const crop = Math.min(image.width, image.height);
        const sx = (image.width - crop) / 2;
        const sy = (image.height - crop) / 2;
        context.drawImage(image, sx, sy, crop, crop, 0, 0, size, size);
      }
      resolve(canvas.toDataURL("image/webp", .82));
    };
    image.src = dataUrl;
  });
}

function renderRoomDirectory(rooms = []) {
  const container = $("publicRoomsList");
  if (!container) return;
  if (!rooms.length) {
    container.innerHTML = '<div class="room-directory-empty">Todavía no hay salas creadas.</div>';
    return;
  }
  container.innerHTML = rooms.map((room, index) => {
    const isPrivate = room.visibility === "private";
    const people = (room.users || []).map(user => `<span class="directory-user" title="${escapeHtml(user.name)}">${user.avatar ? `<img src="${escapeHtml(user.avatar)}" alt="">` : escapeHtml(user.name?.[0]?.toUpperCase() || "?")}</span>`).join("");
    return `<article class="directory-room ${isPrivate ? "private" : "public"}">
      <div class="directory-room-main"><span class="directory-room-icon">${isPrivate ? "🔒" : "🌐"}</span><div><strong>${escapeHtml(room.roomName || "Sala")}</strong><small>${isPrivate ? "Sala privada · requiere código" : `Sala pública · código ${escapeHtml(room.code || "")}`}</small></div></div>
      <div class="directory-room-users"><div class="directory-avatars">${people}</div><span>${Number(room.userCount || 0)} conectado${Number(room.userCount || 0) === 1 ? "" : "s"}</span></div>
      <button type="button" data-directory-join="${index}" ${isPrivate ? 'class="private-room-btn"' : ''}>${isPrivate ? "Usar código" : "Unirme"}</button>
    </article>`;
  }).join("");
  container.querySelectorAll("[data-directory-join]").forEach(button => button.addEventListener("click", () => {
    const room = rooms[Number(button.dataset.directoryJoin)];
    if (!room) return;
    if (room.visibility === "private") {
      $("roomCodeInput")?.focus();
      notify("Esta sala es privada. Escribe su código para entrar.");
      return;
    }
    joinRoomByCode(room.code);
  }));
}

function requestRoomDirectory() {
  socket.emit("list-rooms", {}, response => {
    if (response?.ok) renderRoomDirectory(response.rooms || []);
  });
}

function isHost() {
  return currentRoom && currentRoom.hostId === mySocketId;
}

function parseYouTubeId(value) {
  value = String(value || "").trim();

  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) return value;

  try {
    const url = new URL(value);

    if (url.hostname.includes("youtu.be")) {
      return url.pathname.split("/").filter(Boolean)[0] || null;
    }

    if (url.hostname.includes("youtube.com")) {
      if (url.pathname === "/watch") return url.searchParams.get("v");

      const parts = url.pathname.split("/").filter(Boolean);
      if (["embed", "shorts", "live"].includes(parts[0])) return parts[1] || null;
    }
  } catch {}

  const match = value.match(/(?:v=|youtu\.be\/|embed\/|shorts\/|live\/)([a-zA-Z0-9_-]{11})/);
  return match?.[1] || null;
}

function parseTwitchChannel(value) {
  value = String(value || "").trim();
  if (/^[a-zA-Z0-9_]{2,30}$/.test(value) && !value.includes(" ")) return value.toLowerCase();
  try {
    const url = new URL(value);
    if (!/(^|\.)twitch\.tv$/i.test(url.hostname)) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (!parts.length || ["videos", "directory", "downloads", "settings"].includes(parts[0].toLowerCase())) return null;
    return parts[0].toLowerCase();
  } catch {}
  return null;
}

function showTwitchChannel(channel, autoplay = true) {
  // Invalida cualquier carga asincrónica anterior de YouTube. Sin este token,
  // una petición vieja podía terminar después y volver a reproducir audio oculto.
  playbackRequestVersion += 1;
  const frame = $("twitchPlayer");
  const twitchShell = $("twitchPlayerShell");
  const youtubeShell = $("youtubePlayerShell");
  if (!frame || !channel) return;

  // Solo puede sonar un elemento de la cola a la vez. Al cambiar de YouTube
  // a Twitch, se detiene por completo el video anterior; pausarlo no basta,
  // porque algunos navegadores continúan reproduciendo el audio del iframe oculto.
  // remoteAction evita que esta detención técnica se envíe como una acción manual.
  if (playerReady && player) {
    const previousRemoteAction = remoteAction;
    remoteAction = true;
    try {
      player.mute();
      player.stopVideo();
      player.seekTo(0, false);
      player.clearVideo();
    } catch (_error) {}
    setTimeout(() => {
      remoteAction = previousRemoteAction;
    }, 500);
  }

  youtubeShell?.classList.add("hidden");
  twitchShell?.classList.remove("hidden");

  // Twitch exige que parent sea únicamente el dominio, sin https:// ni rutas.
  // En Render será thesomusic.onrender.com y en local será localhost.
  const parentHost = window.location.hostname || "thesomusic.onrender.com";
  const playerUrl = new URL("https://player.twitch.tv/");
  playerUrl.searchParams.set("channel", String(channel).trim().toLowerCase());
  playerUrl.searchParams.set("parent", parentHost);
  playerUrl.searchParams.set("autoplay", autoplay ? "true" : "false");
  // Los navegadores permiten el autoplay de Twitch con más fiabilidad si inicia silenciado.
  playerUrl.searchParams.set("muted", "true");

  frame.setAttribute("allow", "autoplay; fullscreen; picture-in-picture");
  frame.src = playerUrl.toString();

  console.info("Twitch embed", {
    channel: String(channel).trim().toLowerCase(),
    parent: parentHost,
    autoplay
  });

  twitchPausedChannel = autoplay ? "" : channel;
  if (autoplay) {
    document.body.classList.add("is-playing");
    updatePlayButtonState(true);
    hideActivationButton();
    reportPlaybackPresence("twitch");
  } else {
    reportPlaybackPresence(null);
  }
}

async function showYouTubePlayer() {
  // Descargar el iframe de Twitch detiene completamente el directo antes de
  // iniciar el siguiente elemento de YouTube de la cola.
  const frame = $("twitchPlayer");
  if (frame) frame.src = "about:blank";
  twitchPausedChannel = "";
  $("twitchPlayerShell")?.classList.add("hidden");

  const youtubeShell = $("youtubePlayerShell");
  youtubeShell?.classList.remove("hidden");
  if (youtubeShell) {
    youtubeShell.style.display = "";
    youtubeShell.style.visibility = "visible";
    youtubeShell.style.opacity = "1";
  }

  // Esperar un par de frames evita que YouTube intente cargar mientras su
  // contenedor todavía está oculto después de abandonar Twitch.
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function waitForPlayer(timeout = 10000) {
  if (playerReady) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (playerReady) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeout) {
        clearInterval(timer);
        reject(new Error("El reproductor de YouTube no terminó de cargar."));
      }
    }, 100);
  });
}

let lastReportedPlaybackPresence = null;
function reportPlaybackPresence(type = null) {
  const normalized = ["music", "twitch"].includes(type) ? type : null;
  if (lastReportedPlaybackPresence === normalized) return;
  lastReportedPlaybackPresence = normalized;
  socket.emit("presence-playback", { type: normalized });
}

function showActivationButton() {
  $("activateAudioBtn").classList.remove("hidden");
}

function hideActivationButton() {
  $("activateAudioBtn").classList.add("hidden");
}

async function playCurrentVideo({ allowMutedFallback = true } = {}) {
  await waitForPlayer();

  const tryPlay = async () => {
    try {
      player.playVideo();
    } catch (_error) {}
    await new Promise(resolve => setTimeout(resolve, 650));
    return player.getPlayerState() === YT.PlayerState.PLAYING;
  };

  // Primer intento: conservar audio cuando el navegador ya autorizó la reproducción.
  let started = await tryPlay();

  // Los navegadores pueden bloquear autoplay con sonido para los oyentes. En ese
  // caso se inicia silenciado para que el video no quede negro ni detenido.
  if (!started && allowMutedFallback) {
    try { player.mute(); } catch (_error) {}
    started = await tryPlay();
  }

  // Si el usuario ya activó audio antes en esta pestaña, restaurarlo automáticamente.
  const playbackWasActivated = userActivatedPlayback ||
    sessionStorage.getItem("waveroom-playback-activated") === "1";
  if (started && playbackWasActivated) {
    try { player.unMute(); } catch (_error) {}
  }

  if (started) {
    hideActivationButton();
    document.body.classList.add("is-playing");
    updatePlayButtonState(true);
  } else {
    showActivationButton();
  }

  return started;
}

async function applyRoomPlayback(video, time = 0, playing = true) {
  if (!video) return;

  const requestVersion = ++playbackRequestVersion;
  pendingRoomPlayback = { video, time, playing };
  currentVideo = video;
  updateTrackUI(video);
  if (video.provider === "twitch") {
    showTwitchChannel(video.id, playing);
    document.body.classList.toggle("is-playing", playing);
    updatePlayButtonState(playing);
    reportPlaybackPresence(playing ? "twitch" : null);
    pendingRoomPlayback = null;
    return;
  }
  await showYouTubePlayer();
  await waitForPlayer();
  if (requestVersion !== playbackRequestVersion || currentVideo?.provider === "twitch") return;

  remoteAction = true;
  currentVideo = video;
  updateTrackUI(video);

  if (playing) {
    player.loadVideoById({
      videoId: video.id,
      startSeconds: Math.max(0, Number(time) || 0)
    });
    await playCurrentVideo();
    if (requestVersion !== playbackRequestVersion || currentVideo?.provider === "twitch") {
      try { player.mute(); player.stopVideo(); player.clearVideo(); } catch (_error) {}
      return;
    }
  } else {
    player.cueVideoById({
      videoId: video.id,
      startSeconds: Math.max(0, Number(time) || 0)
    });
    player.pauseVideo();
  }

  pendingRoomPlayback = null;
  setTimeout(() => {
    remoteAction = false;
  }, 450);
}

window.onYouTubeIframeAPIReady = function () {
  player = new YT.Player("youtubePlayer", {
    width: "100%",
    height: "100%",
    playerVars: {
      playsinline: 1,
      controls: 1,
      rel: 0,
      autoplay: 1,
      origin: window.location.origin
    },
    events: {
      onReady: async () => {
        playerReady = true;

        // There is no longer a default YouTube video.
        if (pendingRoomPlayback) {
          const pending = pendingRoomPlayback;
          await applyRoomPlayback(pending.video, pending.time, pending.playing);
        } else if (currentRoom?.video) {
          await applyRoomPlayback(
            currentRoom.video,
            currentRoom.time || 0,
            currentRoom.playing
          );
        }
      },
      onStateChange: event => {
        if (event.data === YT.PlayerState.PLAYING) {
          document.body.classList.add("is-playing");
          updatePlayButtonState(true);
          hideActivationButton();
          userActivatedPlayback = true;
          sessionStorage.setItem("waveroom-playback-activated", "1");
          reportPlaybackPresence("music");
        }

        if (event.data === YT.PlayerState.PAUSED || event.data === YT.PlayerState.ENDED) {
          document.body.classList.remove("is-playing");
          updatePlayButtonState(false);
          reportPlaybackPresence(null);
        }

        if (remoteAction || !currentRoom || !isHost()) return;

        if (event.data === YT.PlayerState.PLAYING) {
          socket.emit("player-action", {
            code: currentRoom.code,
            action: "play",
            time: player.getCurrentTime()
          });
        }

        if (event.data === YT.PlayerState.PAUSED) {
          socket.emit("player-action", {
            code: currentRoom.code,
            action: "pause",
            time: player.getCurrentTime()
          });
        }

        if (event.data === YT.PlayerState.ENDED) nextVideo();
      },
      onError: event => {
        const errors = {
          2: "El enlace del video no es válido.",
          5: "YouTube no pudo reproducir este video.",
          100: "El video fue eliminado o es privado.",
          101: "El propietario no permite reproducir este video fuera de YouTube.",
          150: "El propietario no permite reproducir este video fuera de YouTube."
        };
        notify(errors[event.data] || "No se pudo reproducir este video.");
      }
    }
  });
};

async function loadVideo(video, autoplay = false, startSeconds = 0) {
  if (!video) return;
  const requestVersion = ++playbackRequestVersion;
  currentVideo = video;
  updateTrackUI(video);
  if (video.provider === "twitch") {
    showTwitchChannel(video.id, autoplay);
    updatePlayButtonState(autoplay);
    return;
  }
  await showYouTubePlayer();
  await waitForPlayer();
  if (requestVersion !== playbackRequestVersion || currentVideo?.provider === "twitch") return;

  if (autoplay) {
    player.loadVideoById({
      videoId: video.id,
      startSeconds: Math.max(0, Number(startSeconds) || 0)
    });
    await playCurrentVideo();
    if (requestVersion !== playbackRequestVersion || currentVideo?.provider === "twitch") {
      try { player.mute(); player.stopVideo(); player.clearVideo(); } catch (_error) {}
      return;
    }
  } else {
    player.cueVideoById({
      videoId: video.id,
      startSeconds: Math.max(0, Number(startSeconds) || 0)
    });
  }
}

function renderRoom(room) {
  currentRoom = room;
  saveLastRoom(room);
  updatePlayerDockVisibility();
  $("roomEntry").classList.add("hidden");
  $("roomPanel").classList.remove("hidden");
  $("railRoomChat")?.classList.remove("hidden");
  // Mientras el usuario está dentro de una sala, no se muestran las demás salas.
  $("roomDirectoryCard")?.classList.add("hidden");
  $("roomCode").textContent = `${room.roomName || "Mi sala"} · ${room.code} · ${room.visibility === "private" ? "Privada" : "Pública"}`;
  $("peopleCount").textContent = room.users.length;
  const myRoomUser = room.users.find(user => user.id === mySocketId);
  $("roomRole").textContent = myRoomUser?.roleLabel || (isHost() ? "Anfitrión" : "Oyente");
  $("roleBadge").textContent = isHost() ? "Controlas la sala" : (myRoomUser?.roleLabel || "Escuchando en sala");

  $("people").innerHTML = room.users.map(user => `
    <div class="person${user.banner ? " has-banner" : ""}" data-room-person="${escapeHtml(user.id)}" style="${user.banner ? `--room-user-banner:url('${escapeHtml(user.banner)}')` : ""}">
      <div class="person-banner" aria-hidden="true"></div>
      <div class="person-icon" style="${user.avatar ? `background-image:url('${escapeHtml(user.avatar)}')` : ""}">${user.avatar ? "" : escapeHtml(user.name[0]?.toUpperCase() || "?")}</div>
      <div class="person-details">
        <strong>${escapeHtml(user.name)}</strong>
        <span>${escapeHtml(user.roleLabel || (user.id === room.hostId ? "Anfitrión" : "Oyente"))}${user.id === mySocketId ? " · Tú" : ""}</span>
      </div>
      ${isHost() && user.id !== room.hostId ? `<div class="room-role-tools"><select data-role-user="${escapeHtml(user.id)}"><option value="listener" ${user.role === "listener" ? "selected" : ""}>Oyente</option><option value="moderator" ${user.role === "moderator" ? "selected" : ""}>Moderador</option><option value="dj" ${user.role === "dj" ? "selected" : ""}>DJ</option><option value="guest" ${user.role === "guest" ? "selected" : ""}>Invitado</option><option value="muted" ${user.role === "muted" ? "selected" : ""}>Silenciado</option></select><button type="button" data-room-permissions="${escapeHtml(user.id)}" title="Permisos">⚙</button><button type="button" data-kick-user="${escapeHtml(user.id)}" title="Expulsar">⛔</button><button type="button" data-ban-user="${escapeHtml(user.id)}" title="Banear">🚫</button></div>` : ""}
      ${user.id !== mySocketId ? `<div class="person-safety-tools"><button type="button" data-block-user="${escapeHtml(user.id)}" title="Bloquear">🔕</button><button type="button" data-report-user="${escapeHtml(user.id)}" title="Reportar">⚑</button></div>` : ""}
      ${user.id !== mySocketId && activeLoginMode === "discord" && String(user.clientId || "").startsWith("discord_") ? `<button class="person-add-friend" type="button" data-add-friend="${escapeHtml(user.clientId || user.id)}" title="Enviar solicitud de amistad">＋</button>` : ""}
    </div>
  `).join("");
  $("people").querySelectorAll("[data-add-friend]").forEach(button => button.addEventListener("click", event => { event.stopPropagation(); sendFriendRequest(button.dataset.addFriend); }));
  $("people").querySelectorAll("[data-role-user]").forEach(select => select.addEventListener("change", event => { event.stopPropagation(); socket.emit("set-room-role", { code: currentRoom.code, targetSocketId: select.dataset.roleUser, role: select.value }, response => { if (!response?.ok) notify(response?.error); }); }));
  $("people").querySelectorAll("[data-room-permissions]").forEach(button => button.addEventListener("click", event => {
    event.stopPropagation(); const user = currentRoom.users.find(u => u.id === button.dataset.roomPermissions); if (!user) return;
    const current = user.permissions || {};
    const answer = prompt("Permisos personalizados (1=Sí, 0=No)\nPausar,Saltar,Borrar cola,Agregar Twitch,Expulsar", [current.pause?1:0,current.skip?1:0,current.deleteQueue?1:0,current.addTwitch?1:0,current.kick?1:0].join(","));
    if (answer == null) return; const parts=answer.split(",").map(v=>v.trim()==="1");
    socket.emit("set-room-role", { code: currentRoom.code, targetSocketId: user.id, role: user.role || "listener", permissions: { pause:parts[0], skip:parts[1], deleteQueue:parts[2], addTwitch:parts[3], kick:parts[4] } }, response => { if (!response?.ok) notify(response?.error); });
  }));
  $("people").querySelectorAll("[data-kick-user]").forEach(button => button.addEventListener("click", event => { event.stopPropagation(); if (confirm("¿Expulsar a este usuario?")) socket.emit("kick-user", { code: currentRoom.code, targetSocketId: button.dataset.kickUser }, response => { if (!response?.ok) notify(response?.error); }); }));
  $("people").querySelectorAll("[data-ban-user]").forEach(button => button.addEventListener("click", event => { event.stopPropagation(); if (confirm("¿Banear permanentemente de esta sala a este usuario?")) socket.emit("ban-user", { code: currentRoom.code, targetSocketId: button.dataset.banUser }, response => { if (!response?.ok) notify(response?.error); else notify("Usuario baneado."); }); }));
  $("people").querySelectorAll("[data-block-user]").forEach(button => button.addEventListener("click", event => { event.stopPropagation(); socket.emit("block-user", { code: currentRoom.code, targetSocketId: button.dataset.blockUser }, response => notify(response?.ok ? "Usuario bloqueado para esta sesión." : response?.error)); }));
  $("people").querySelectorAll("[data-report-user]").forEach(button => button.addEventListener("click", event => { event.stopPropagation(); const reason = prompt("Motivo del reporte:", "Spam o comportamiento inapropiado"); if (!reason) return; socket.emit("report-user", { code: currentRoom.code, targetSocketId: button.dataset.reportUser, reason }, response => notify(response?.ok ? "Reporte enviado." : response?.error)); }));
  refreshRoomSpeakingIndicators();

  $("queueCount").textContent = room.queue.length;
  $("chatCount").textContent = room.users.length;
  if ($("railChatCount")) $("railChatCount").textContent = room.users.length;
  renderFriendsList();
  if (activePrivateClientId) { const active = room.users.find(user => (user.clientId || user.id) === activePrivateClientId); activePrivateUserId = active?.id || null; }
  $("queue").innerHTML = room.queue.length ? room.queue.map(video => `
    <div class="queue-item" data-queue-index="${room.queue.indexOf(video)}">
      <img src="${video.thumbnail || `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`}" alt="">
      <div>
        <strong>${escapeHtml(video.title)}</strong>
        <span>${escapeHtml(video.addedBy || video.channel || "YouTube")}</span>
      </div>
      ${(currentRoom?.users?.find(u => u.id === mySocketId)?.permissions?.deleteQueue || isHost()) ? `<button class="queue-remove-btn" type="button" data-remove-queue="${room.queue.indexOf(video)}" title="Borrar">×</button>` : ""}
    </div>
  `).join("") : `<div class="empty-queue"><b>♫</b><strong>La cola está vacía</strong><p>Agrega canciones para escuchar juntos.</p></div>`;

  $("queue").querySelectorAll("[data-remove-queue]").forEach(button => button.onclick = () => socket.emit("remove-queue-item", { code: room.code, index: Number(button.dataset.removeQueue) }, response => { if (!response?.ok) notify(response?.error); }));
  if ($("voteSkipText")) $("voteSkipText").textContent = `${room.skipVote?.votes || 0}/${room.skipVote?.needed || 1}`;
  if ($("voteSkipBtn")) $("voteSkipBtn").classList.toggle("voted", Boolean(room.skipVote?.voters?.includes?.(mySocketId)));

  if (room.video) {
    if (currentVideo?.id !== room.video.id) {
      applyRoomPlayback(room.video, room.time || 0, room.playing).catch(() => {
        notify("No se pudo cargar la canción activa.");
      });
    }
  } else if (currentVideo && room.waitingForQueue) {
    remoteAction = true;
    if (playerReady) player.stopVideo();
    currentVideo = null;
    updateTrackUI(null);
    document.body.classList.remove("is-playing");
    setTimeout(() => { remoteAction = false; }, 300);
  }

  if (room.chat?.length && !$("messages").dataset.loaded) {
    $("messages").innerHTML = "";
    room.chat.forEach(addMessage);
    $("messages").dataset.loaded = "1";
    scrollRoomChatToBottom("auto");
  }

  updateVoiceUsers(room.voiceUsers || []);
  startSync();
}

function clearPlaybackAfterLeavingRoom() {
  // Al salir de una sala se detienen y descargan ambos reproductores para que
  // no continúe sonando ningún video o directo perteneciente a esa sala.
  const previousRemoteAction = remoteAction;
  remoteAction = true;

  const twitchFrame = $("twitchPlayer");
  if (twitchFrame) twitchFrame.src = "about:blank";
  twitchPausedChannel = "";
  $("twitchPlayerShell")?.classList.add("hidden");
  $("youtubePlayerShell")?.classList.remove("hidden");

  try {
    if (playerReady && player) {
      player.stopVideo();
      player.mute();
    }
  } catch (_error) {}

  currentVideo = null;
  pendingRoomPlayback = null;
  hideActivationButton();
  updateTrackUI(null);
  updatePlayButtonState(false);
  document.body.classList.remove("is-playing");

  if ($("currentTime")) $("currentTime").textContent = "0:00";
  if ($("durationTime")) $("durationTime").textContent = "0:00";
  if ($("progressBar")) $("progressBar").value = 0;

  setTimeout(() => {
    remoteAction = previousRemoteAction;
  }, 350);
}

function resetRoomUI() {
  reportPlaybackPresence(null);
  leaveVoiceChat(false);
  clearPlaybackAfterLeavingRoom();
  currentRoom = null;
  updatePlayerDockVisibility();
  $("roomEntry").classList.remove("hidden");
  $("roomPanel").classList.add("hidden");
  $("railRoomChat")?.classList.add("hidden");
  $("railEmojiPicker")?.classList.add("hidden");
  // Al salir de la sala, vuelve a mostrarse el directorio para poder elegir otra.
  $("roomDirectoryCard")?.classList.remove("hidden");
  requestRoomDirectory();
  $("roleBadge").textContent = "Modo individual";
  $("people").innerHTML = "";
  $("queueCount").textContent = "0";
  $("chatCount").textContent = "0";
  if ($("railChatCount")) $("railChatCount").textContent = "0";
  $("queue").innerHTML = `<div class="empty-queue"><b>♫</b><strong>La cola está vacía</strong><p>Agrega canciones para escuchar juntos.</p></div>`;
  $("messages").innerHTML = `<p class="muted">Entra a una sala para conversar.</p>`;
  if ($("railMessages")) $("railMessages").innerHTML = `<p class="empty-state">Entra a una sala para conversar.</p>`;
  if (privateCallTargetId || privateCallActive) endPrivateCall(true);
  activePrivateUserId = null;
  loadPrivateConversations();
  delete $("messages").dataset.loaded;
  if ($("railMessages")) delete $("railMessages").dataset.loaded;
  clearInterval(syncInterval);
}

function startSync() {
  clearInterval(syncInterval);

  syncInterval = setInterval(() => {
    if (!currentRoom || isHost() || !playerReady) return;

    socket.emit("request-sync", { code: currentRoom.code }, async response => {
      if (!response?.ok || !response.video) return;

      if (currentVideo?.id !== response.video.id) {
        await applyRoomPlayback(response.video, response.time, response.playing);
        return;
      }

      const localTime = player.getCurrentTime() || 0;
      if (Math.abs(localTime - response.time) > 1.4) {
        remoteAction = true;
        player.seekTo(response.time, true);
        setTimeout(() => remoteAction = false, 300);
      }

      const state = player.getPlayerState();
      remoteAction = true;

      if (response.playing && state !== YT.PlayerState.PLAYING) {
        await playCurrentVideo();
      } else if (!response.playing && state === YT.PlayerState.PLAYING) {
        player.pauseVideo();
      }

      setTimeout(() => remoteAction = false, 300);
    });
  }, 3500);
}

function refreshRoomSpeakingIndicators() {
  const canSeeSpeaking = voiceJoined;
  document.querySelectorAll("[data-room-person]").forEach(person => {
    const id = person.dataset.roomPerson;
    const isInVoiceCall = voiceAnalysers.has(id) || id === mySocketId;
    const isSpeaking = canSeeSpeaking && isInVoiceCall && speakingUsers.has(id) && voiceMutedUsers.get(id) !== true;
    person.classList.toggle("speaking", isSpeaking);
  });
}

function getVoiceUserName(id) {
  return currentRoom?.users?.find(user => user.id === id)?.name || "Usuario";
}

function getStoredVoiceUserVolume(id) {
  if (!voiceUserVolumes.has(id)) {
    const saved = Number(localStorage.getItem(`waveroom-voice-user-${id}`) ?? 100);
    voiceUserVolumes.set(id, Math.max(0, Math.min(100, saved)));
  }
  return voiceUserVolumes.get(id);
}

function applyVoiceVolume(id) {
  const audio = document.getElementById(`voice-audio-${id}`);
  if (!audio) return;
  const individual = getStoredVoiceUserVolume(id) / 100;
  audio.volume = Math.max(0, Math.min(1, (voiceOutputVolume / 100) * individual));
}

function setVoiceUserVolume(id, value) {
  const safeValue = Math.max(0, Math.min(100, Number(value) || 0));
  voiceUserVolumes.set(id, safeValue);
  localStorage.setItem(`waveroom-voice-user-${id}`, String(safeValue));
  applyVoiceVolume(id);
  const valueLabel = document.querySelector(`[data-voice-volume-value="${CSS.escape(id)}"]`);
  if (valueLabel) valueLabel.textContent = `${safeValue}%`;
}

function updateVoiceUsers(ids = []) {
  const activeIds = Array.isArray(ids) ? ids : [];
  for (const id of [...voicePeers.keys()]) {
    if (!activeIds.includes(id)) closeVoicePeer(id);
  }
  $("voiceCount").textContent = activeIds.length;

  if (!currentRoom) {
    $("voiceStatus").textContent = "Entra a una sala para hablar";
    $("voiceJoinBtn").disabled = true;
  } else if (!voiceJoined) {
    $("voiceStatus").textContent = activeIds.length
      ? `${activeIds.length} persona${activeIds.length === 1 ? "" : "s"} conectada${activeIds.length === 1 ? "" : "s"}`
      : "Nadie está en el chat de voz";
    $("voiceJoinBtn").disabled = false;
  } else {
    $("voiceStatus").textContent = voiceMuted ? "Micrófono silenciado" : "Micrófono activo";
  }

  $("voiceParticipants").innerHTML = activeIds.map(id => {
    const rawName = getVoiceUserName(id);
    const name = id === mySocketId ? `${rawName} · Tú` : rawName;
    const muted = voiceMutedUsers.get(id) === true;
    const speaking = speakingUsers.has(id) && !muted;
    const initial = rawName.trim().charAt(0).toUpperCase() || "U";
    const volume = id === mySocketId ? 100 : getStoredVoiceUserVolume(id);
    const controls = id === mySocketId ? "" : `
      <label class="voice-user-volume" title="Volumen de ${escapeHtml(rawName)}">
        <span>Volumen</span>
        <input type="range" min="0" max="100" value="${volume}" data-voice-user="${escapeHtml(id)}" aria-label="Volumen de ${escapeHtml(rawName)}">
        <strong data-voice-volume-value="${escapeHtml(id)}">${volume}%</strong>
      </label>`;
    return `<div class="voice-member${muted ? " muted" : ""}${speaking ? " speaking" : ""}" data-voice-member="${escapeHtml(id)}">
      <div class="voice-avatar" aria-hidden="true">${escapeHtml(initial)}</div>
      <div class="voice-member-info"><strong>${escapeHtml(name)}</strong><small>${muted ? "Micrófono silenciado" : speaking ? "Hablando" : "Conectado"}</small></div>
      ${controls}
    </div>`;
  }).join("");

  $("voiceParticipants").querySelectorAll("[data-voice-user]").forEach(input => {
    input.addEventListener("input", event => {
      setVoiceUserVolume(event.currentTarget.dataset.voiceUser, event.currentTarget.value);
    });
  });
}

function attachVoiceAnalyser(id, stream) {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass || !stream) return;
    const context = new AudioContextClass();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.55;
    source.connect(analyser);
    voiceAnalysers.set(id, { context, source, analyser, data: new Uint8Array(analyser.fftSize) });
    startVoiceMeter();
  } catch (error) {
    console.warn("No se pudo iniciar el indicador de voz:", error);
  }
}

function removeVoiceAnalyser(id) {
  const meter = voiceAnalysers.get(id);
  if (!meter) return;
  try { meter.source.disconnect(); } catch {}
  meter.context.close().catch(() => {});
  voiceAnalysers.delete(id);
  speakingUsers.delete(id);
  refreshRoomSpeakingIndicators();
}

function startVoiceMeter() {
  if (voiceMeterFrame) return;
  const tick = () => {
    let changed = false;
    for (const [id, meter] of voiceAnalysers.entries()) {
      meter.analyser.getByteTimeDomainData(meter.data);
      let sum = 0;
      for (const value of meter.data) {
        const normalized = (value - 128) / 128;
        sum += normalized * normalized;
      }
      const level = Math.sqrt(sum / meter.data.length);
      const speaking = level > 0.035 && voiceMutedUsers.get(id) !== true;
      if (speaking !== speakingUsers.has(id)) {
        speaking ? speakingUsers.add(id) : speakingUsers.delete(id);
        changed = true;
      }
      const member = document.querySelector(`[data-voice-member="${CSS.escape(id)}"]`);
      if (member) {
        member.classList.toggle("speaking", speaking);
        const status = member.querySelector("small");
        if (status && voiceMutedUsers.get(id) !== true) status.textContent = speaking ? "Hablando" : "Conectado";
      }
    }
    if (changed && currentRoom) {
      refreshRoomSpeakingIndicators();
    }
    if (voiceAnalysers.size) voiceMeterFrame = requestAnimationFrame(tick);
    else voiceMeterFrame = null;
  };
  voiceMeterFrame = requestAnimationFrame(tick);
}

function setVoiceControls(joined) {
  voiceJoined = joined;
  refreshRoomSpeakingIndicators();
  $("voiceJoinBtn").classList.toggle("hidden", joined);
  $("voiceMuteBtn").classList.toggle("hidden", !joined);
  $("voiceLeaveBtn").classList.toggle("hidden", !joined);
  if (!joined) {
    voiceMuted = false;
    $("voiceMuteBtn").classList.remove("is-muted");
    $("voiceMuteBtn").textContent = "🔇 Silenciar";
  }
}

function closeVoicePeer(id) {
  const peer = voicePeers.get(id);
  if (peer) {
    peer.close();
    voicePeers.delete(id);
  }
  document.getElementById(`voice-audio-${id}`)?.remove();
  removeVoiceAnalyser(id);
}

function createVoicePeer(id) {
  if (voicePeers.has(id)) return voicePeers.get(id);
  const peer = new RTCPeerConnection(rtcConfig);
  voicePeers.set(id, peer);

  voiceStream?.getTracks().forEach(track => peer.addTrack(track, voiceStream));

  peer.onicecandidate = event => {
    if (event.candidate && currentRoom) {
      socket.emit("voice-signal", {
        code: currentRoom.code,
        target: id,
        data: { type: "candidate", candidate: event.candidate }
      });
    }
  };

  peer.ontrack = event => {
    let audio = document.getElementById(`voice-audio-${id}`);
    if (!audio) {
      audio = document.createElement("audio");
      audio.id = `voice-audio-${id}`;
      audio.autoplay = true;
      audio.playsInline = true;
      audio.volume = 1;
      $("remoteAudios").appendChild(audio);
    }
    audio.srcObject = event.streams[0];
    applyVoiceVolume(id);
    if (!voiceAnalysers.has(id)) attachVoiceAnalyser(id, event.streams[0]);
    audio.play().catch(() => notify("Toca la pantalla para activar el audio del chat de voz."));
  };

  peer.onconnectionstatechange = () => {
    if (["failed", "closed"].includes(peer.connectionState)) closeVoicePeer(id);
  };

  return peer;
}

async function makeVoiceOffer(id) {
  const peer = createVoicePeer(id);
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  socket.emit("voice-signal", {
    code: currentRoom.code,
    target: id,
    data: { type: "offer", sdp: peer.localDescription }
  });
}

async function joinVoiceChat() {
  if (!currentRoom) return notify("Primero crea o entra a una sala.");
  if (!navigator.mediaDevices?.getUserMedia) {
    return notify("Este navegador no permite usar el micrófono.");
  }

  $("voiceJoinBtn").disabled = true;
  $("voiceStatus").textContent = "Solicitando permiso del micrófono...";

  try {
    voiceRawStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: voiceNoiseFilterEnabled,
        noiseSuppression: voiceNoiseFilterEnabled,
        autoGainControl: voiceNoiseFilterEnabled,
        channelCount: 1,
        sampleRate: { ideal: 48000 },
        sampleSize: { ideal: 16 },
        latency: { ideal: 0.02 }
      },
      video: false
    });

    voiceStream = await createEnhancedVoiceStream(voiceRawStream, voiceNoiseFilterEnabled);

    socket.emit("voice-join", { code: currentRoom.code }, async response => {
      if (!response?.ok) {
        voiceStream?.getTracks().forEach(track => track.stop());
        voiceRawStream?.getTracks().forEach(track => track.stop());
        closeVoiceFilterGraph();
        voiceStream = null;
        voiceRawStream = null;
        $("voiceJoinBtn").disabled = false;
        return notify(response?.error || "No se pudo entrar al chat de voz.");
      }

      setVoiceControls(true);
      voiceMutedUsers.set(mySocketId, false);
      attachVoiceAnalyser(mySocketId, voiceStream);
      $("voiceStatus").textContent = "Micrófono activo";
      notify("Entraste al chat de voz.");

      for (const id of response.peers || []) {
        try { await makeVoiceOffer(id); } catch (error) { console.error("Offer error:", error); }
      }
    });
  } catch (error) {
    console.error("Micrófono:", error);
    $("voiceJoinBtn").disabled = false;
    $("voiceStatus").textContent = "No se pudo activar el micrófono";
    notify("Debes permitir el acceso al micrófono.");
  }
}

async function createEnhancedVoiceStream(rawStream, enabled) {
  await closeVoiceFilterGraph();
  if (!enabled || !rawStream) return rawStream;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return rawStream;
  try {
    const context = new AudioContextClass({ latencyHint: "interactive", sampleRate: 48000 });
    const source = context.createMediaStreamSource(rawStream);
    const highPass = context.createBiquadFilter();
    highPass.type = "highpass"; highPass.frequency.value = 105; highPass.Q.value = 0.75;
    const lowPass = context.createBiquadFilter();
    lowPass.type = "lowpass"; lowPass.frequency.value = 7800; lowPass.Q.value = 0.65;
    const presence = context.createBiquadFilter();
    presence.type = "peaking"; presence.frequency.value = 3000; presence.Q.value = 0.9; presence.gain.value = 2.5;
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.82;
    const gateGain = context.createGain(); gateGain.gain.value = 1;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -38; compressor.knee.value = 18; compressor.ratio.value = 6; compressor.attack.value = 0.003; compressor.release.value = 0.18;
    const outputGain = context.createGain(); outputGain.gain.value = 0.94;
    const destination = context.createMediaStreamDestination();
    source.connect(highPass); highPass.connect(lowPass); lowPass.connect(presence);
    presence.connect(analyser); analyser.connect(gateGain); gateGain.connect(compressor); compressor.connect(outputGain); outputGain.connect(destination);
    const samples = new Uint8Array(analyser.fftSize);
    let noiseFloor = 0.008;
    let gateFrame = 0;
    const updateGate = () => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const value of samples) { const x = (value - 128) / 128; sum += x * x; }
      const rms = Math.sqrt(sum / samples.length);
      if (rms < noiseFloor * 1.8) noiseFloor = noiseFloor * 0.985 + rms * 0.015;
      const threshold = Math.max(0.012, noiseFloor * 2.25);
      const target = rms > threshold ? 1 : Math.max(0.045, rms / threshold * 0.18);
      gateGain.gain.setTargetAtTime(target, context.currentTime, target > gateGain.gain.value ? 0.012 : 0.075);
      gateFrame = requestAnimationFrame(updateGate);
    };
    updateGate();
    if (context.state === "suspended") await context.resume();
    voiceFilterGraph = { context, source, highPass, lowPass, presence, analyser, gateGain, compressor, outputGain, destination, gateFrame };
    return destination.stream;
  } catch (error) {
    console.warn("Procesamiento avanzado de voz no disponible:", error);
    await closeVoiceFilterGraph();
    return rawStream;
  }
}

async function closeVoiceFilterGraph() {
  if (!voiceFilterGraph) return;
  try { cancelAnimationFrame(voiceFilterGraph.gateFrame); } catch {}
  try { voiceFilterGraph.source?.disconnect(); } catch {}
  try { voiceFilterGraph.highPass?.disconnect(); } catch {}
  try { voiceFilterGraph.lowPass?.disconnect(); } catch {}
  try { voiceFilterGraph.presence?.disconnect(); } catch {}
  try { voiceFilterGraph.analyser?.disconnect(); } catch {}
  try { voiceFilterGraph.gateGain?.disconnect(); } catch {}
  try { voiceFilterGraph.compressor?.disconnect(); } catch {}
  try { voiceFilterGraph.outputGain?.disconnect(); } catch {}
  try { await voiceFilterGraph.context?.close(); } catch {}
  voiceFilterGraph = null;
}

async function replaceVoiceTrackForPeers(newTrack) {
  for (const peer of voicePeers.values()) {
    const sender = peer.getSenders().find(item => item.track?.kind === "audio");
    if (sender) {
      try { await sender.replaceTrack(newTrack); } catch (error) { console.warn("No se pudo reemplazar la pista:", error); }
    }
  }
}

async function applyVoiceNoiseFilter(enabled, showNotice = true) {
  voiceNoiseFilterEnabled = Boolean(enabled);
  localStorage.setItem("waveroom-voice-noise-filter", String(voiceNoiseFilterEnabled));

  const rawTrack = voiceRawStream?.getAudioTracks?.()[0];
  if (!rawTrack) return;

  try {
    if (rawTrack.applyConstraints) {
      await rawTrack.applyConstraints({
        echoCancellation: voiceNoiseFilterEnabled,
        noiseSuppression: voiceNoiseFilterEnabled,
        autoGainControl: voiceNoiseFilterEnabled,
        channelCount: 1
      });
    }

    const oldStream = voiceStream;
    voiceStream = await createEnhancedVoiceStream(voiceRawStream, voiceNoiseFilterEnabled);
    const newTrack = voiceStream.getAudioTracks()[0];
    if (newTrack) {
      newTrack.enabled = !voiceMuted;
      await replaceVoiceTrackForPeers(newTrack);
      removeVoiceAnalyser(mySocketId);
      attachVoiceAnalyser(mySocketId, voiceStream);
    }

    if (oldStream && oldStream !== voiceRawStream && oldStream !== voiceStream) {
      oldStream.getTracks().forEach(track => track.stop());
    }

    if (showNotice) {
      notify(voiceNoiseFilterEnabled
        ? "Filtro avanzado activado: eco, ruido, graves y picos reducidos."
        : "Filtro anti ruido desactivado.");
    }
  } catch (error) {
    console.warn("No se pudo cambiar el filtro anti ruido:", error);
    if (showNotice) notify("El navegador no pudo cambiar el filtro del micrófono.");
  }
}

function toggleVoiceMute() {
  if (!voiceStream) return;
  voiceMuted = !voiceMuted;
  voiceStream.getAudioTracks().forEach(track => { track.enabled = !voiceMuted; });
  voiceMutedUsers.set(mySocketId, voiceMuted);
  $("voiceMuteBtn").classList.toggle("is-muted", voiceMuted);
  $("voiceMuteBtn").textContent = voiceMuted ? "🎙 Activar micrófono" : "🔇 Silenciar";
  $("voiceStatus").textContent = voiceMuted ? "Micrófono silenciado" : "Micrófono activo";
  if (currentRoom) socket.emit("voice-mute", { code: currentRoom.code, muted: voiceMuted });
  updateVoiceUsers(currentRoom?.voiceUsers || [...voicePeers.keys(), mySocketId]);
}

function leaveVoiceChat(notifyServer = true) {
  if (notifyServer && currentRoom && socket.connected) {
    socket.emit("voice-leave", { code: currentRoom.code });
  }
  voiceStream?.getTracks().forEach(track => track.stop());
  voiceRawStream?.getTracks().forEach(track => track.stop());
  closeVoiceFilterGraph();
  voiceStream = null;
  voiceRawStream = null;
  [...voicePeers.keys()].forEach(closeVoicePeer);
  voiceMutedUsers.clear();
  [...voiceAnalysers.keys()].forEach(removeVoiceAnalyser);
  speakingUsers.clear();
  $("remoteAudios").innerHTML = "";
  setVoiceControls(false);
  if (currentRoom) {
    $("voiceStatus").textContent = "Fuera del chat de voz";
    $("voiceJoinBtn").disabled = false;
  }
}

async function prepareChatImage(file) {
  const allowed = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  if (!file || !allowed.includes(file.type)) throw new Error("Usa una imagen PNG, JPG, WEBP o GIF.");
  if (file.size > 10 * 1024 * 1024) throw new Error("La imagen no puede superar 10 MB.");

  if (file.type === "image/gif") {
    if (file.size > 3.5 * 1024 * 1024) throw new Error("El GIF debe pesar menos de 3.5 MB.");
    return { data: await readFileDataUrl(file), name: file.name };
  }

  const source = await readFileDataUrl(file);
  const image = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("No se pudo leer la imagen."));
    img.src = source;
  });
  const maxSide = 1280;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  return { data: canvas.toDataURL("image/webp", .82), name: file.name.replace(/\.[^.]+$/, ".webp") };
}

function readFileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("No se pudo leer la imagen."));
    reader.readAsDataURL(file);
  });
}

function imageMessageHtml(image) {
  if (!image?.data) return "";
  return `<button class="chat-image-open" type="button" data-chat-image="${escapeHtml(image.data)}"><img class="chat-image" src="${escapeHtml(image.data)}" alt="${escapeHtml(image.name || "Imagen")}" loading="lazy"></button>`;
}

function bindChatImages(container) {
  container.querySelectorAll("[data-chat-image]").forEach(button => {
    button.addEventListener("click", () => {
      $("imageViewerImg").src = button.dataset.chatImage;
      $("imageViewer").classList.remove("hidden");
    });
  });
}

async function sendRoomImage(file) {
  if (!currentRoom) return notify("Primero entra a una sala.");
  try {
    notify("Preparando imagen...");
    const image = await prepareChatImage(file);
    socket.emit("chat", { code: currentRoom.code, text: "", image }, response => {
      if (!response?.ok) notify(response?.error || "No se pudo enviar la imagen.");
    });
  } catch (error) { notify(error.message); }
}

async function sendPrivateImage(file) {
  if (!activePrivateClientId) return notify("Selecciona una conversación privada.");
  try {
    notify("Preparando imagen...");
    const image = await prepareChatImage(file);
    socket.emit("private-chat-global", { clientId: persistentClientId, targetClientId: activePrivateClientId, text: "", image }, response => {
      if (!response?.ok) notify(response?.error || "No se pudo enviar la imagen.");
    });
  } catch (error) { notify(error.message); }
}

function scrollRoomChatToBottom(behavior = "smooth") {
  [$("messages"), $("railMessages")].filter(Boolean).forEach(box => {
    const move = () => {
      try { box.scrollTo({ top: box.scrollHeight, behavior }); }
      catch (_) { box.scrollTop = box.scrollHeight; }
    };
    requestAnimationFrame(() => { move(); requestAnimationFrame(move); });
  });
}

function buildRoomMessage(message) {
  const div = document.createElement("div");
  if (message.author) {
    div.className = "message";
    div.innerHTML = `<strong>${escapeHtml(message.author)}</strong>${message.text ? `<p>${escapeHtml(message.text)}</p>` : ""}${imageMessageHtml(message.image)}`;
    bindChatImages(div);
  } else {
    div.className = "system";
    div.textContent = message.text;
  }
  return div;
}

function addMessage(message) {
  [$("messages"), $("railMessages")].filter(Boolean).forEach(box => {
    box.querySelector(".muted, .empty-state")?.remove();
    const div = buildRoomMessage(message);
    div.querySelectorAll("img").forEach(img => {
      if (!img.complete) img.addEventListener("load", () => scrollRoomChatToBottom("auto"), { once: true });
    });
    box.appendChild(div);
  });
  scrollRoomChatToBottom();
}


function decodeHtmlEntities(text) {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = String(text || "");
  return textarea.value;
}

async function startSelectedVideo(video) {
  if (!video?.id) return;

  // The click/submit that calls this function counts as a user interaction,
  // so browsers normally allow playback with sound for the host.
  userActivatedPlayback = true;
  sessionStorage.setItem("waveroom-playback-activated", "1");
  hideActivationButton();

  if (currentRoom) {
    if (!isHost()) {
      return notify("Solo el anfitrión puede cambiar la canción.");
    }

    socket.emit("set-video", { code: currentRoom.code, video }, response => {
      if (!response?.ok) return notify(response?.error);
      notify(`Reproduciendo: ${video.title}`);
    });
  } else {
    await loadVideo(video, true, 0);
  }
}


function addVideoToQueue(video) {
  if (!video?.id) {
    return notify("No se pudo reconocer la canción.");
  }

  if (!currentRoom) {
    return notify("Primero crea o entra a una sala para usar la cola.");
  }

  socket.emit("add-queue", {
    code: currentRoom.code,
    video
  }, response => {
    if (!response?.ok) {
      return notify(response?.error || "No se pudo agregar a la cola.");
    }

    if (response.autoStarted) {
      notify(`"${video.title}" comenzó automáticamente.`);
    } else {
      notify(`"${video.title}" se agregó a la cola sin interrumpir la canción actual.`);
    }
  });
}

async function searchYouTube(query) {
  const status = $("searchStatus");
  const resultsContainer = $("searchResults");

  status.textContent = "Buscando en YouTube...";
  resultsContainer.innerHTML = "";

  try {
    const response = await fetch(
      `/api/youtube/search?q=${encodeURIComponent(query)}`
    );
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "No se pudo realizar la búsqueda.");
    }

    const results = data.results || [];

    if (!results.length) {
      status.textContent = "No se encontraron resultados.";
      resultsContainer.innerHTML =
        `<div class="search-empty">Prueba con otro nombre o agrega el artista.</div>`;
      return;
    }

    status.textContent = `${results.length} resultados. Agrega canciones a la cola sin detener la actual.`;

    resultsContainer.innerHTML = results.map((item, index) => `
      <article class="search-result">
        <img src="${escapeHtml(item.thumbnail)}" alt="">
        <div class="search-result-info">
          <strong>${escapeHtml(decodeHtmlEntities(item.title))}</strong>
          <span>${escapeHtml(decodeHtmlEntities(item.channel))}</span>

          <div class="search-result-actions">
            <button
              class="queue-result-btn"
              type="button"
              data-add-queue-index="${index}"
            >
              + Agregar a cola
            </button>

            <button
              class="play-result-btn"
              type="button"
              data-play-now-index="${index}"
              ${currentRoom && !isHost() ? "disabled title=\"Solo el anfitrión puede reproducir ahora\"" : ""}
            >
              Reproducir ahora
            </button>
          </div>
        </div>
      </article>
    `).join("");

    function resultToVideo(index) {
      const item = results[Number(index)];

      return {
        provider: "youtube",
        id: item.id,
        title: decodeHtmlEntities(item.title),
        channel: decodeHtmlEntities(item.channel),
        thumbnail: item.thumbnail
      };
    }

    resultsContainer
      .querySelectorAll("[data-add-queue-index]")
      .forEach(button => {
        button.addEventListener("click", () => {
          const video = resultToVideo(button.dataset.addQueueIndex);
          addVideoToQueue(video);
        });
      });

    resultsContainer
      .querySelectorAll("[data-play-now-index]")
      .forEach(button => {
        button.addEventListener("click", async () => {
          const video = resultToVideo(button.dataset.playNowIndex);

          $("youtubeUrl").value =
            `https://www.youtube.com/watch?v=${video.id}`;
          await startSelectedVideo(video);
        });
      });
  } catch (error) {
    status.textContent = error.message;
    resultsContainer.innerHTML =
      `<div class="search-empty">${escapeHtml(error.message)}</div>`;
  }
}

async function searchTwitch(query) {
  const status = $("twitchSearchStatus");
  const resultsContainer = $("twitchSearchResults");
  status.textContent = "Buscando canales en directo en Twitch...";
  resultsContainer.innerHTML = "";
  try {
    const response = await fetch(`/api/twitch/search?q=${encodeURIComponent(query)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "No se pudo buscar en Twitch.");
    const results = data.results || [];
    if (!results.length) {
      status.textContent = "No se encontraron canales en directo.";
      resultsContainer.innerHTML = `<div class="search-empty">Prueba con el nombre exacto del canal.</div>`;
      return;
    }
    status.textContent = `${results.length} directos encontrados.`;
    resultsContainer.innerHTML = results.map((item,index)=>`<article class="search-result live-result"><img src="${escapeHtml(item.thumbnail)}" alt=""><div class="search-result-info"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.channel)} · ${escapeHtml(item.category || "Twitch")} · ${Number(item.viewers||0).toLocaleString()} espectadores</span><b class="live-badge">EN VIVO</b><div class="search-result-actions"><button class="queue-result-btn" type="button" data-twitch-queue="${index}">+ Agregar a cola</button><button class="play-result-btn" type="button" data-twitch-play="${index}" ${currentRoom && !isHost() ? 'disabled title="Solo el anfitrión puede reproducir ahora"' : ''}>Reproducir ahora</button></div></div></article>`).join("");
    const toVideo=i=>({ ...results[Number(i)], provider:"twitch", live:true });
    resultsContainer.querySelectorAll("[data-twitch-queue]").forEach(btn=>btn.addEventListener("click",()=>addVideoToQueue(toVideo(btn.dataset.twitchQueue))));
    resultsContainer.querySelectorAll("[data-twitch-play]").forEach(btn=>btn.addEventListener("click",()=>startSelectedVideo(toVideo(btn.dataset.twitchPlay))));
  } catch(error) {
    status.textContent = error.message;
    resultsContainer.innerHTML = `<div class="search-empty">${escapeHtml(error.message)}</div>`;
  }
}

function videoFromTwitchLink(value) {
  const channel = parseTwitchChannel(value);
  if (!channel) return null;
  return { provider:"twitch", id:channel, title:`${channel} en directo`, channel, thumbnail:"", live:true };
}

async function videoFromYouTubeLink(value, optionalTitle = "") {
  const id = parseYouTubeId(value);
  if (!id) return null;

  const fallback = {
    provider: "youtube",
    id,
    title: optionalTitle.trim() || "Video de YouTube",
    channel: "YouTube",
    thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
  };

  try {
    const canonicalUrl = `https://www.youtube.com/watch?v=${id}`;
    const response = await fetch(`/api/youtube/info?url=${encodeURIComponent(canonicalUrl)}`);
    const data = await response.json();

    if (!response.ok) return fallback;

    return {
      provider: "youtube",
      id,
      title: optionalTitle.trim() || data.title || fallback.title,
      channel: data.channel || fallback.channel,
      thumbnail: data.thumbnail || fallback.thumbnail
    };
  } catch (_error) {
    return fallback;
  }
}

async function addYouTubeLinkDirectlyToQueue(value, optionalTitle = "") {
  const video = await videoFromYouTubeLink(value, optionalTitle);

  if (!video) {
    notify("El enlace de YouTube no es válido.");
    return false;
  }

  addVideoToQueue(video);
  return true;
}

function clearYouTubeLinkFields() {
  if ($("youtubeUrl")) $("youtubeUrl").value = "";
  if ($("searchInput") && searchProvider === "youtube") $("searchInput").value = "";
  if ($("searchMirror")) $("searchMirror").value = "";
}

function clearTwitchLinkFields() {
  if ($("twitchUrl")) $("twitchUrl").value = "";
  if ($("searchInput") && searchProvider === "twitch") $("searchInput").value = "";
  if ($("twitchSearchInput")) $("twitchSearchInput").value = "";
}

$("searchForm").addEventListener("submit", async event => {
  event.preventDefault();
  const query = $("searchInput").value.trim();
  if (!query) return notify(searchProvider === "twitch" ? "Escribe un canal de Twitch." : "Escribe una canción o enlace de YouTube.");

  if (searchProvider === "twitch") {
    $("twitchSearchInput").value = query;
    const video = videoFromTwitchLink(query);
    if (video && /twitch\.tv/i.test(query)) {
      addVideoToQueue(video);
      clearTwitchLinkFields();
      $("twitchSearchStatus").textContent = "Directo de Twitch agregado a la cola.";
      $("twitchSearchResults").innerHTML = "";
    } else {
      await searchTwitch(query);
    }
    return;
  }

  $("searchMirror").value = query;
  if (/(?:^|\.)twitch\.tv/i.test((() => { try { return new URL(query).hostname; } catch { return ""; } })())) {
    return notify("Ese enlace pertenece a Twitch. Usa la pestaña Twitch.");
  }
  if (parseYouTubeId(query)) {
    const added = await addYouTubeLinkDirectlyToQueue(query);
    if (added) {
      clearYouTubeLinkFields();
      $("searchStatus").textContent = "Enlace de YouTube agregado a su cola.";
      $("searchResults").innerHTML = "";
    }
    return;
  }
  await searchYouTube(query);
});

function selectedVideo() {
  const id = parseYouTubeId($("youtubeUrl").value);
  if (!id) return null;

  return {
    id,
    title: "Video de YouTube"
  };
}

$("videoForm").addEventListener("submit", async event => {
  event.preventDefault();
  const url = $("youtubeUrl").value.trim();
  if (!url) return notify("Pega un enlace de YouTube primero.");
  if (!parseYouTubeId(url)) return notify("Pega un enlace válido de YouTube.");
  const added = await addYouTubeLinkDirectlyToQueue(url);
  if (added) {
    clearYouTubeLinkFields();
    $("searchStatus").textContent = "Enlace de YouTube agregado a su cola.";
  }
});

$("twitchVideoForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  const url = $("twitchUrl").value.trim();
  const video = videoFromTwitchLink(url);
  if (!video || !/twitch\.tv/i.test(url)) return notify("Pega un enlace válido de Twitch.");
  addVideoToQueue(video);
  clearTwitchLinkFields();
  $("twitchSearchStatus").textContent = "Directo de Twitch agregado a la cola.";
});

function updatePlayButtonState(playing) {
  const icon = $("playBtnIcon");
  const button = $("playBtn");
  if (icon) icon.setAttribute("href", playing ? "#i-pause" : "#i-play");
  if (button) button.title = playing ? "Pausar" : "Reproducir";
}

$("playBtn").addEventListener("click", async () => {
  if (!currentVideo) return notify("Primero selecciona un video o directo.");
  if (currentRoom && !isHost()) return notify("Solo el anfitrión controla la reproducción.");
  const isPlaying = document.body.classList.contains("is-playing");
  if (currentVideo.provider === "twitch") {
    if (isPlaying) {
      twitchPausedChannel = currentVideo.id;
      $("twitchPlayer").src = "about:blank";
      document.body.classList.remove("is-playing");
      updatePlayButtonState(false);
      if (currentRoom) socket.emit("player-action", { code: currentRoom.code, action: "pause", time: 0 });
    } else {
      showTwitchChannel(currentVideo.id, true);
      document.body.classList.add("is-playing");
      updatePlayButtonState(true);
      if (currentRoom) socket.emit("player-action", { code: currentRoom.code, action: "play", time: 0 });
    }
    return;
  }
  userActivatedPlayback = true;
  sessionStorage.setItem("waveroom-playback-activated", "1");
  if (isPlaying) player.pauseVideo(); else await playCurrentVideo();
});

$("activateAudioBtn").addEventListener("click", async () => {
  userActivatedPlayback = true;
  sessionStorage.setItem("waveroom-playback-activated", "1");

  if (currentRoom?.video) {
    await applyRoomPlayback(
      currentRoom.video,
      currentRoom.time || 0,
      currentRoom.playing
    );
  } else if (currentVideo) {
    await playCurrentVideo();
  }

  hideActivationButton();
});



$("syncBtn").addEventListener("click", () => {
  if (!currentRoom) return notify("No estás en una sala.");

  socket.emit("request-sync", { code: currentRoom.code }, async response => {
    if (!response?.ok || !response.video) return notify("No hay video activo.");

    await applyRoomPlayback(response.video, response.time, response.playing);
    notify("Reproductor sincronizado.");
  });
});

$("queueBtn").addEventListener("click", () => {
  const video = selectedVideo() || currentVideo;

  if (!video) {
    return notify("Selecciona una canción o pega un enlace de YouTube.");
  }

  addVideoToQueue(video);
});

function nextVideo() {
  if (!currentRoom) return notify("La función siguiente se usa dentro de una sala.");
  const me = currentRoom.users?.find(user => user.id === mySocketId);
  if (!isHost() && !me?.permissions?.skip) return socket.emit("vote-skip", { code: currentRoom.code }, response => { if (!response?.ok) notify(response?.error); });

  socket.emit("next-video", { code: currentRoom.code }, response => {
    if (!response?.ok) notify(response?.error);
  });
}

$("nextBtn").addEventListener("click", nextVideo);
$("voteSkipBtn")?.addEventListener("click", () => { if (!currentRoom) return notify("Primero entra a una sala."); socket.emit("vote-skip", { code: currentRoom.code }, response => { if (!response?.ok) notify(response?.error); }); });

$("createRoom").addEventListener("click", () => {
  socket.emit("create-room", {
    ...getProfile(),
    visibility: $("roomVisibility")?.value || "public",
    roomName: $("roomNameInput")?.value.trim() || ""
  }, response => {
    if (!response?.ok) return notify(response?.error);
    mySocketId = response.socketId;
    renderRoom(response.room);
    if ($("roomNameInput")) $("roomNameInput").value = "";
    notify(`${response.room.visibility === "private" ? "Sala privada" : "Sala pública"} ${response.room.code} creada.`);
  });
});

async function joinRoomByCode(rawCode) {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!code) return notify("Escribe el código.");
  socket.emit("join-room", { code, ...getProfile() }, async response => {
    if (!response?.ok) return notify(response?.error);
    mySocketId = response.socketId;
    renderRoom(response.room);
    if ($("roomCodeInput")) $("roomCodeInput").value = "";
    if (response.room.video) {
      pendingRoomPlayback = { video: response.room.video, time: response.room.time || 0, playing: response.room.playing };
      try { await applyRoomPlayback(response.room.video, response.room.time || 0, response.room.playing); }
      catch { notify("El reproductor todavía está cargando."); }
    }
    notify(`Entraste a ${response.room.roomName || response.room.code}.`);
  });
}

$("joinRoom").addEventListener("click", () => joinRoomByCode($("roomCodeInput").value));
$("roomCodeInput")?.addEventListener("keydown", event => { if (event.key === "Enter") joinRoomByCode(event.currentTarget.value); });
$("refreshRooms")?.addEventListener("click", requestRoomDirectory);

$("leaveRoom").addEventListener("click", () => {
  if (!currentRoom) return;
  socket.emit("leave-room", { code: currentRoom.code }, () => {
    clearLastRoom();
    resetRoomUI();
    notify("Saliste de la sala.");
  });
});

$("copyCode").addEventListener("click", async () => {
  if (!currentRoom) return;
  await navigator.clipboard.writeText(currentRoom.code);
  notify("Código copiado.");
});

$("chatForm").addEventListener("submit", event => {
  event.preventDefault();
  if (!currentRoom) return notify("Primero entra a una sala.");

  const input = $("chatInput");
  const text = input.value.trim();
  if (!text) return;

  socket.emit("chat", { code: currentRoom.code, text }, response => {
    if (response?.ok) input.value = "";
    else notify(response?.error || "No se pudo enviar el mensaje.");
  });
});

$("railChatForm")?.addEventListener("submit", event => {
  event.preventDefault();
  if (!currentRoom) return notify("Primero entra a una sala.");
  const input = $("railChatInput");
  const text = input.value.trim();
  if (!text) return;
  socket.emit("chat", { code: currentRoom.code, text }, response => {
    if (response?.ok) input.value = "";
  });
});

$("focusRooms").addEventListener("click", openRoomModal);
$("closeRoomModal").addEventListener("click", closeRoomModal);
$("roomModal").querySelector("[data-close-room]").addEventListener("click", closeRoomModal);

setupNotificationBell();
window.addEventListener("pointerdown", () => {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass && !notificationAudioContext) notificationAudioContext = new AudioContextClass();
    notificationAudioContext?.resume?.().catch(() => {});
  } catch {}
}, { once: true });

$("friendsShortcut").addEventListener("click", openFriendsModal);
$("closeFriends").addEventListener("click", closeFriendsModal);
$("friendsModal").querySelector("[data-close-friends]").addEventListener("click", closeFriendsModal);

setupEmojiPicker("roomEmojiBtn", "roomEmojiPicker", "chatInput", "room");
setupEmojiPicker("railEmojiBtn", "railEmojiPicker", "railChatInput", "room");
setupEmojiPicker("privateEmojiBtn", "privateEmojiPicker", "privateChatInput", "private");
$("roomImageBtn").addEventListener("click", () => $("roomImageInput").click());
$("railImageBtn")?.addEventListener("click", () => $("railImageInput")?.click());
$("privateImageBtn").addEventListener("click", () => $("privateImageInput").click());
$("roomImageInput").addEventListener("change", event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) sendRoomImage(file); });
$("railImageInput")?.addEventListener("change", event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) sendRoomImage(file); });
$("privateImageInput").addEventListener("change", event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) sendPrivateImage(file); });
$("chatInput").addEventListener("paste", event => { const file = [...(event.clipboardData?.files || [])].find(f => f.type.startsWith("image/")); if (file) { event.preventDefault(); sendRoomImage(file); } });
$("railChatInput")?.addEventListener("paste", event => { const file = [...(event.clipboardData?.files || [])].find(f => f.type.startsWith("image/")); if (file) { event.preventDefault(); sendRoomImage(file); } });
$("privateChatInput").addEventListener("paste", event => { const file = [...(event.clipboardData?.files || [])].find(f => f.type.startsWith("image/")); if (file) { event.preventDefault(); sendPrivateImage(file); } });
for (const [zoneId, sender] of [["messages", sendRoomImage], ["railMessages", sendRoomImage], ["privateMessages", sendPrivateImage]]) {
  const zone = $(zoneId);
  zone.addEventListener("dragover", event => { event.preventDefault(); zone.classList.add("drop-active"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("drop-active"));
  zone.addEventListener("drop", event => { event.preventDefault(); zone.classList.remove("drop-active"); const file = [...event.dataTransfer.files].find(f => f.type.startsWith("image/")); if (file) sender(file); });
}
$("closeImageViewer").addEventListener("click", () => $("imageViewer").classList.add("hidden"));
$("imageViewer").addEventListener("click", event => { if (event.target === $("imageViewer")) $("imageViewer").classList.add("hidden"); });
$("inviteToRoomBtn")?.addEventListener("click", () => {
  if (!currentRoom || !activePrivateClientId) return notify("Primero entra a una sala y abre el chat de un amigo.");
  socket.emit("room-invite", { targetClientId: activePrivateClientId, code: currentRoom.code }, response => {
    notify(response?.ok ? "Invitación enviada." : (response?.error || "No se pudo enviar la invitación."));
    if (response?.ok) addAppNotification("Invitación enviada", `Invitaste a ${$("privateChatName")?.textContent || "un amigo"} a ${currentRoom.roomName || "tu sala"}.`, "room");
  });
});

$("privateCallBtn").addEventListener("click", startPrivateCall);
$("privateHangupBtn").addEventListener("click", () => endPrivateCall(true));
$("acceptPrivateCall").addEventListener("click", acceptPrivateCallInvite);
$("rejectPrivateCall").addEventListener("click", rejectPrivateCallInvite);
$("privateCallPanelHangup").addEventListener("click", () => endPrivateCall(true));
$("privateCallPanelMute").addEventListener("click", () => {
  if (!privateCallActive || !voiceStream) return;
  voiceMuted = !voiceMuted;
  voiceStream.getAudioTracks().forEach(track => { track.enabled = !voiceMuted; });
  $("privateCallPanelMute").textContent = voiceMuted ? "🎙 Activar micrófono" : "🔇 Silenciar";
  $("privateCallStatus").textContent = voiceMuted ? "Micrófono silenciado" : "Llamada privada activa";
  updatePrivateCallPanel(true, $("privateCallStatus").textContent);
});

$("privateChatForm").addEventListener("submit", event => {
  event.preventDefault();
  if (!requireDiscordSocial("Los invitados no pueden enviar mensajes privados.")) return;
  if (!activePrivateClientId) return notify("Selecciona una conversación privada.");
  const input = $("privateChatInput");
  const text = input.value.trim();
  if (!text) return;
  const targetClientId = activePrivateClientId;
  socket.emit("private-chat-global", { clientId: persistentClientId, targetClientId, text, replyToId: privateReplyTarget?.id || null }, response => {
    if (!response?.ok) return notify(response?.error || "No se pudo enviar el mensaje privado.");
    input.value = "";
    setPrivateReply(null);
    socket.emit("private-typing", { targetClientId, typing: false });
    privateTypingSent = false;
    // Refresca inmediatamente el historial del remitente, incluso si el evento
    // de Socket.IO tarda unos milisegundos o la conexión acaba de recuperarse.
    socket.emit("private-chat-history-global", { clientId: persistentClientId, targetClientId }, history => {
      if (history?.ok && activePrivateClientId === targetClientId) renderPrivateMessages(history.messages || []);
    });
  });
});

$("cancelPrivateReply")?.addEventListener("click", () => setPrivateReply(null));
$("privateChatSearch")?.addEventListener("input", event => {
  privateSearchTerm = event.target.value || "";
  renderPrivateMessages(privateMessageCache.get(activePrivateClientId) || []);
});
$("privateChatInput")?.addEventListener("input", () => {
  if (!activePrivateClientId || activeLoginMode !== "discord") return;
  if (!privateTypingSent) {
    privateTypingSent = true;
    socket.emit("private-typing", { targetClientId: activePrivateClientId, typing: true });
  }
  clearTimeout(privateTypingTimer);
  privateTypingTimer = setTimeout(() => {
    privateTypingSent = false;
    socket.emit("private-typing", { targetClientId: activePrivateClientId, typing: false });
  }, 1200);
});

$("openProfile").addEventListener("click", openProfileModal);
$("closeProfile").addEventListener("click", closeProfileModal);
$("cancelProfile").addEventListener("click", closeProfileModal);
$("profileModal").querySelector("[data-close-profile]").addEventListener("click", closeProfileModal);

$("profilePhoto").addEventListener("change", async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    event.target.value = "";
    return notify("La foto debe pesar menos de 5 MB.");
  }

  try {
    profilePhotoData = await prepareProfileImage(file, "avatar");
    applyAvatar($("profilePreview"));
  } catch (error) {
    notify(error.message);
  }
});

$("removePhoto").addEventListener("click", () => {
  profilePhotoData = "";
  $("profilePhoto").value = "";
  applyAvatar($("profilePreview"));
});

$("profileBanner").addEventListener("change", async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    profileBannerData = await prepareProfileImage(file, "banner");
    applyProfileBanner($("profileBannerPreview"));
  } catch (error) {
    event.target.value = "";
    notify(error.message);
  }
});

$("removeBanner").addEventListener("click", () => {
  profileBannerData = "";
  $("profileBanner").value = "";
  applyProfileBanner($("profileBannerPreview"));
});

username.addEventListener("input", () => {
  applyAvatar($("profilePreview"), getName(), profilePhotoData);
  if ($("profilePreviewName")) $("profilePreviewName").textContent = getName();
});

$("profileForm").addEventListener("submit", event => {
  event.preventDefault();
  const name = getName();
  username.value = name;
  localStorage.setItem("waveroom-name", name);
  try {
    if (profilePhotoData) localStorage.setItem("waveroom-photo", profilePhotoData);
    else localStorage.removeItem("waveroom-photo");
    if (profileBannerData) localStorage.setItem("waveroom-banner", profileBannerData);
    else localStorage.removeItem("waveroom-banner");
    if (activeLoginMode === "guest") saveGuestProfile();
    if (activeLoginMode === "discord") {
      // Quitar la foto personalizada vuelve al avatar oficial de Discord.
      if (!profilePhotoData && discordAuthenticatedUser?.avatar) {
        profilePhotoData = discordAuthenticatedUser.avatar;
        localStorage.setItem("waveroom-photo", profilePhotoData);
      }
      saveDiscordProfile();
    }
  } catch {
    return notify("No se pudo guardar: reduce el peso del GIF o del banner.");
  }
  refreshProfileUI();

  // Actualizar el perfil no debe desconectar ni reiniciar el chat de voz.
  // Se conserva el micrófono, los peers WebRTC, el estado de silencio y los controles.
  if (currentRoom) {
    socket.emit("update-profile", { code: currentRoom.code, ...getProfile() }, response => {
      if (!response?.ok) return notify(response?.error || "No se pudo actualizar el perfil.");
      notify("Perfil actualizado.");
    });
  } else {
    notify("Perfil guardado.");
  }

  closeProfileModal();
});

document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;

  // Salas se cierra igual que los demás paneles, sin abandonar la llamada grupal.
  if (!$("roomModal").classList.contains("hidden")) {
    closeRoomModal();
    return;
  }

  if (!$("profileModal").classList.contains("hidden")) {
    closeProfileModal();
    return;
  }

  if (!$("friendsModal").classList.contains("hidden")) {
    closeFriendsModal();
  }
});

socket.on("connect", () => {
  mySocketId = socket.id;
  $("connectedText").textContent = "Conectado";
  requestRoomDirectory();

  // Primero se une el socket al canal client:<id>. Solo después se cargan
  // conversaciones e historial, evitando la carrera que impedía recibir mensajes
  // hasta que el destinatario enviaba uno.
  registerPersistentClient(() => {
    loadFriendState();
    loadPrivateConversations();
    if (activePrivateClientId) {
      socket.emit("private-chat-history-global", { clientId: persistentClientId, targetClientId: activePrivateClientId }, response => {
        if (response?.ok && activePrivateClientId) renderPrivateMessages(response.messages || []);
      });
    }
  });
});

socket.on("disconnect", () => {
  $("connectedText").textContent = "Desconectado";
  leaveVoiceChat(false);
  endPrivateCall(false);
});

socket.on("rooms-list", rooms => renderRoomDirectory(rooms || []));

socket.on("room-state", room => {
  if (currentRoom?.code === room.code) renderRoom(room);
});

socket.on("video-changed", async ({ video, playing, time }) => {
  await applyRoomPlayback(video, time || 0, playing);
});

socket.on("queue-ended", () => {
  remoteAction = true;
  hideActivationButton();

  // La cola terminó: detener tanto YouTube como Twitch para que ningún
  // reproductor oculto continúe sonando.
  const twitchFrame = $("twitchPlayer");
  if (twitchFrame) twitchFrame.src = "about:blank";
  $("twitchPlayerShell")?.classList.add("hidden");

  if (!playerReady) {
    currentVideo = null;
    document.body.classList.remove("is-playing");
    updatePlayButtonState(false);
    setTimeout(() => { remoteAction = false; }, 350);
    return;
  }

  // stopVideo cancela cualquier repetición residual de los últimos segundos
  // que algunos navegadores producen al recibir nuevas sincronizaciones.
  player.stopVideo();
  currentVideo = null;
  if (currentRoom) {
    currentRoom.video = null;
    currentRoom.playing = false;
    currentRoom.waitingForQueue = true;
  }
  $("currentTime").textContent = "0:00";
  $("durationTime").textContent = "0:00";
  $("progressBar").value = 0;
  updateTrackUI(null);
  document.body.classList.remove("is-playing");

  setTimeout(() => {
    remoteAction = false;
  }, 350);
});

socket.on("player-action", async ({ action, time, serverTime }) => {
  if (!playerReady) return;
  remoteAction = true;

  const adjustedTime = action === "play"
    ? time + Math.max(0, (Date.now() - serverTime) / 1000)
    : time;

  if (Math.abs((player.getCurrentTime() || 0) - adjustedTime) > .35) {
    player.seekTo(adjustedTime, true);
  }

  if (action === "play") await playCurrentVideo();
  if (action === "pause") player.pauseVideo();
  if (action === "seek") player.seekTo(time, true);

  setTimeout(() => remoteAction = false, 350);
});

socket.on("voice-users", ids => {
  if (currentRoom) currentRoom.voiceUsers = ids;
  updateVoiceUsers(ids);
});

socket.on("voice-muted", ({ id, muted }) => {
  voiceMutedUsers.set(id, Boolean(muted));
  updateVoiceUsers(currentRoom?.voiceUsers || []);
});

socket.on("voice-peer-left", ({ id }) => {
  closeVoicePeer(id);
  voiceMutedUsers.delete(id);
});

socket.on("voice-signal", async ({ from, data }) => {
  if (!voiceJoined || !currentRoom || !data) return;
  try {
    const peer = createVoicePeer(from);
    if (data.type === "offer") {
      await peer.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      socket.emit("voice-signal", {
        code: currentRoom.code,
        target: from,
        data: { type: "answer", sdp: peer.localDescription }
      });
    } else if (data.type === "answer") {
      await peer.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } else if (data.type === "candidate" && data.candidate) {
      await peer.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
  } catch (error) {
    console.error("Error de WebRTC:", error);
  }
});


socket.on("skip-vote-updated", state => { if ($("voteSkipText")) $("voteSkipText").textContent = `${state?.votes || 0}/${state?.needed || 1}`; });
socket.on("role-updated", ({ roleLabel }) => { notify(`Tu rol ahora es ${roleLabel || "Oyente"}.`); });
socket.on("kicked-from-room", ({ reason }) => { clearLastRoom(); resetRoomUI(); notify(reason || "Fuiste expulsado de la sala."); });

socket.on("room-invite", invite => {
  const roomLabel = invite?.roomName || "una sala";
  const sender = invite?.fromName || "Un amigo";
  addAppNotification("Invitación a sala", `${sender} te invitó a ${roomLabel}. Abre su chat para unirte.`, "room");
  playNotificationSound();
  showPrivateMessageToast({ author: sender, text: `Te invitó a ${roomLabel}` }, invite?.fromClientId || "");
});

socket.on("private-call-invite", ({ from, name }) => {
  if (activeLoginMode !== "discord") return;
  addFriendsNotification("Llamada privada", `${name || "Un usuario"} te está llamando.`, { icon: "📞", userId: from });
  incomingPrivateCallerId = from;
  const user = getRoomUser(from);
  $("incomingPrivateCallText").textContent = `${name || user?.name || "Un usuario"} te está llamando en privado`;
  $("incomingPrivateCall").classList.remove("hidden");
  openFriendsModal();
});

socket.on("private-call-response", async ({ from, accepted }) => {
  if (from !== privateCallTargetId) return;
  if (!accepted) { notify("La llamada privada fue rechazada."); return endPrivateCall(false); }
  try {
    const peer = createPrivateCallPeer(from);
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    socket.emit("private-call-signal", { code: currentRoom.code, target: from, data: { type: "offer", sdp: peer.localDescription } });
    setPrivateCallUi(true, "Llamada privada activa");
  } catch (error) { console.error(error); endPrivateCall(true); }
});

socket.on("private-call-signal", async ({ from, data }) => {
  if (!currentRoom || from !== privateCallTargetId || !data) return;
  try {
    const peer = privateCallPeer || createPrivateCallPeer(from);
    if (data.type === "offer") {
      await peer.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      socket.emit("private-call-signal", { code: currentRoom.code, target: from, data: { type: "answer", sdp: peer.localDescription } });
      setPrivateCallUi(true, "Llamada privada activa");
    } else if (data.type === "answer") await peer.setRemoteDescription(new RTCSessionDescription(data.sdp));
    else if (data.type === "candidate" && data.candidate) await peer.addIceCandidate(new RTCIceCandidate(data.candidate));
  } catch (error) { console.error("Llamada privada:", error); }
});

socket.on("private-call-end", ({ from }) => {
  if (from === privateCallTargetId) { notify("La llamada privada terminó."); endPrivateCall(false); }
});

// El servidor envía este evento únicamente al destinatario. Así el aviso
// aparece siempre, incluso cuando la conversación ya está abierta.
socket.on("friend-request-received", request => {
  if (activeLoginMode !== "discord") return;
  addFriendsNotification("Nueva solicitud de amistad", `${request.name || "Un usuario"} quiere agregarte.`, { clientId: request.clientId, icon: "👋" });
  notify(`${request.name || "Un usuario"} te envió una solicitud de amistad.`);
  loadFriendState();
  loadPrivateConversations();
});

socket.on("friend-state-changed", ({ type } = {}) => {
  if (activeLoginMode !== "discord") return;
  notify(type === "accepted" ? "Ahora son amigos." : "La solicitud fue actualizada.");
  loadFriendState();
  loadPrivateConversations();
});

socket.on("private-message-notification", message => {
  // Los chats persistentes pertenecen exclusivamente a una cuenta Discord.
  // Ignora eventos retrasados del socket anterior después de cerrar sesión.
  if (activeLoginMode !== "discord") return;
  if (!message || message.fromClientId === persistentClientId) return;
  const otherClientId = message.fromClientId;
  mergePrivateMessages(otherClientId, [message]);
  const privateChatIsOpen = activePrivateClientId === otherClientId && !$("friendsModal").classList.contains("hidden");

  // Si la conversación está cerrada, también se marca como no leída.
  if (!privateChatIsOpen) {
    privateUnread.set(otherClientId, (privateUnread.get(otherClientId) || 0) + 1);
    updatePrivateUnreadBadge();
  }

  addFriendsNotification(
    "Nuevo mensaje privado",
    `${message.author || "Usuario"}: ${message.text || "Envió una imagen"}`,
    { icon: "💬", userId: message.fromSocketId || null, clientId: otherClientId }
  );
  showPrivateMessageToast(message, otherClientId);
  playPrivateMessageSound();
  showNativePrivateNotification(message, otherClientId);
  renderFriendsList();
});

socket.on("private-chat-global", message => {
  if (activeLoginMode !== "discord" || !message) return;
  const otherClientId = message.fromClientId === persistentClientId ? message.toClientId : message.fromClientId;
  const messages = mergePrivateMessages(otherClientId, [message]);
  const privateChatIsOpen = activePrivateClientId === otherClientId && !$("friendsModal").classList.contains("hidden");

  // Se pinta directamente desde el mensaje recibido, sin esperar otra escritura
  // ni una segunda consulta al servidor. Después se sincroniza el historial.
  if (privateChatIsOpen) {
    privateUnread.delete(otherClientId);
    updatePrivateUnreadBadge();
    socket.emit("private-message-read", { targetClientId: otherClientId });
    renderPrivateMessages(messages);
    socket.emit("private-chat-history-global", { clientId: persistentClientId, targetClientId: otherClientId }, response => {
      if (!response?.ok || activePrivateClientId !== otherClientId) return;
      renderPrivateMessages(mergePrivateMessages(otherClientId, response.messages || []));
    });
  }
  loadPrivateConversations();
});

socket.on("chat", addMessage);
socket.on("presence-changed", contact => {
  if (!contact?.clientId || activeLoginMode !== "discord") return;
  const apply = list => list.map(item => item.clientId === contact.clientId ? { ...item, ...contact } : item);
  persistentFriends = apply(persistentFriends);
  savedPrivateContacts = apply(savedPrivateContacts);
  renderFriendsList();
  if (activePrivateClientId === contact.clientId) $("privateCallStatus").textContent = contact.presenceLabel || "Chat privado";
});

socket.on("private-typing", ({ fromClientId, typing } = {}) => {
  if (fromClientId !== activePrivateClientId) return;
  $("privateTypingIndicator")?.classList.toggle("hidden", !typing);
});

socket.on("private-message-updated", message => updateCachedPrivateMessage(message));
socket.on("private-messages-read", ({ byClientId, at } = {}) => {
  const list = privateMessageCache.get(byClientId) || [];
  list.forEach(message => { if (message.fromClientId === persistentClientId && !message.readAt) message.readAt = at || Date.now(); });
  privateMessageCache.set(byClientId, list);
  if (activePrivateClientId === byClientId) renderPrivateMessages(list);
});

socket.on("system-message", text => addMessage({ text }));
socket.on("became-host", () => notify("Ahora eres el anfitrión."));


$("voiceNoiseFilter").checked = voiceNoiseFilterEnabled;
$("voiceNoiseFilter").addEventListener("change", event => {
  applyVoiceNoiseFilter(event.currentTarget.checked, true);
});

$("voiceJoinBtn").addEventListener("click", joinVoiceChat);
$("voiceMuteBtn").addEventListener("click", toggleVoiceMute);
$("voiceLeaveBtn").addEventListener("click", () => {
  leaveVoiceChat(true);
  notify("Saliste del chat de voz.");
});

// Controles y accesos visuales del nuevo diseño.
$("miniProfile").addEventListener("click", () => openProfileModal("profile"));
$("settingsShortcut")?.addEventListener("click", () => openProfileModal("theme"));

$("searchMirrorBtn").addEventListener("click", () => {
  $("searchInput").value = $("searchMirror").value.trim();
  $("searchForm").requestSubmit();
});
$("searchMirror").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    $("searchMirrorBtn").click();
  }
});

$("twitchSearchBtn")?.addEventListener("click", async () => {
  const query = $("twitchSearchInput").value.trim();
  if (!query) return notify("Escribe el nombre de un canal de Twitch.");
  $("searchInput").value = query;
  const video = videoFromTwitchLink(query);
  if (video && /twitch\.tv/i.test(query)) {
    addVideoToQueue(video);
    clearTwitchLinkFields();
    $("twitchSearchStatus").textContent = "Directo de Twitch agregado a la cola.";
    $("twitchSearchResults").innerHTML = "";
  } else {
    await searchTwitch(query);
  }
});
$("twitchSearchInput")?.addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    $("twitchSearchBtn").click();
  }
});

setSearchProvider(localStorage.getItem("theso-active-provider") || "youtube");

document.querySelectorAll("[data-query]").forEach(button => {
  button.addEventListener("click", () => {
    $("searchInput").value = button.dataset.query;
    $("searchMirror").value = button.dataset.query;
    $("searchForm").requestSubmit();
    $("searchSection").scrollIntoView({ behavior: "smooth" });
  });
});

function paintRange(input) {
  input.style.setProperty("--range-progress", `${Number(input.value) || 0}%`);
}

const savedMusicVolume = Math.max(0, Math.min(100, Number(localStorage.getItem("waveroom-music-volume") ?? $("volumeBar").value)));
$("volumeBar").value = savedMusicVolume;
paintRange($("volumeBar"));
paintRange($("progressBar"));

$("volumeBar").addEventListener("input", () => {
  const value = Number($("volumeBar").value);
  paintRange($("volumeBar"));
  localStorage.setItem("waveroom-music-volume", String(value));
  if (playerReady) player.setVolume(value);
});

$("voiceVolumeBar").value = voiceOutputVolume;
$("voiceVolumeValue").textContent = `${voiceOutputVolume}%`;
paintRange($("voiceVolumeBar"));

$("voiceVolumeBar").addEventListener("input", () => {
  voiceOutputVolume = Number($("voiceVolumeBar").value);
  $("voiceVolumeValue").textContent = `${voiceOutputVolume}%`;
  if ($("privateCallVolumeBar")) $("privateCallVolumeBar").value = voiceOutputVolume;
  if ($("privateCallVolumeValue")) $("privateCallVolumeValue").textContent = `${voiceOutputVolume}%`;
  paintRange($("voiceVolumeBar"));
  if ($("privateCallVolumeBar")) paintRange($("privateCallVolumeBar"));
  localStorage.setItem("waveroom-voice-volume", String(voiceOutputVolume));
  for (const id of voicePeers.keys()) applyVoiceVolume(id);
  document.querySelectorAll("#remoteAudios audio").forEach(audio => {
    audio.volume = voiceOutputVolume / 100;
  });
});

$("privateCallVolumeBar").value = voiceOutputVolume;
$("privateCallVolumeValue").textContent = `${voiceOutputVolume}%`;
paintRange($("privateCallVolumeBar"));
$("privateCallVolumeBar").addEventListener("input", () => {
  voiceOutputVolume = Number($("privateCallVolumeBar").value);
  $("privateCallVolumeValue").textContent = `${voiceOutputVolume}%`;
  $("voiceVolumeBar").value = voiceOutputVolume;
  $("voiceVolumeValue").textContent = `${voiceOutputVolume}%`;
  paintRange($("privateCallVolumeBar"));
  paintRange($("voiceVolumeBar"));
  localStorage.setItem("waveroom-voice-volume", String(voiceOutputVolume));
  const audio = document.getElementById("private-call-audio");
  if (audio) audio.volume = voiceOutputVolume / 100;
});

$("progressBar").addEventListener("input", () => {
  paintRange($("progressBar"));
});

$("progressBar").addEventListener("change", () => {
  if (!playerReady || !currentVideo) return;
  const duration = player.getDuration() || 0;
  const target = duration * Number($("progressBar").value) / 100;
  player.seekTo(target, true);
  if (currentRoom && isHost()) {
    socket.emit("player-action", { code: currentRoom.code, action: "seek", time: target });
  }
});

setInterval(() => {
  if (!playerReady || !currentVideo) return;
  const current = player.getCurrentTime() || 0;
  const duration = player.getDuration() || 0;
  $("currentTime").textContent = formatTime(current);
  $("durationTime").textContent = formatTime(duration);
  $("progressBar").value = duration ? Math.min(100, current / duration * 100) : 0;
  paintRange($("progressBar"));
}, 500);

updateTrackUI(null);


const THEME_DEFAULTS = {
  accent: "#89ff18",
  accent2: "#5bd90b",
  purple: "#8b5cf6",
  background: "#050811",
  panel: "#0a0f1a",
  sidebar: "#080c15",
  text: "#f5f7fb",
  border: "#202735",
  activeMenu: "#173415"
};

const THEME_PRESETS = {
  green: { ...THEME_DEFAULTS },
  purple: { accent: "#b65cff", accent2: "#7b36ff", purple: "#ff63d8", background: "#080510", panel: "#120b1c", sidebar: "#0d0716", text: "#fff5ff", border: "#3b2250", activeMenu: "#342044" },
  blue: { accent: "#37d8ff", accent2: "#2477ff", purple: "#7c5cff", background: "#040912", panel: "#081525", sidebar: "#06101d", text: "#f2fbff", border: "#173a54", activeMenu: "#0d3047" },
  red: { accent: "#ff4d5f", accent2: "#d6253e", purple: "#ff8a3d", background: "#0b0508", panel: "#170a10", sidebar: "#12070b", text: "#fff5f6", border: "#4a1c26", activeMenu: "#3a141d" },
  cyber: { accent: "#00f5ff", accent2: "#ff2bd6", purple: "#8d5cff", background: "#05040d", panel: "#0d0a1a", sidebar: "#090713", text: "#f6fbff", border: "#2d2550", activeMenu: "#25144a" },
  sunset: { accent: "#ff7a18", accent2: "#ff3d81", purple: "#9b5cff", background: "#12080a", panel: "#211014", sidebar: "#160b0e", text: "#fff7f1", border: "#5a2830", activeMenu: "#4a1d24" },
  ocean: { accent: "#2ee6c5", accent2: "#168cff", purple: "#6f7cff", background: "#031018", panel: "#071b26", sidebar: "#05151d", text: "#effcff", border: "#16465a", activeMenu: "#103d49" },
  rose: { accent: "#ff5ac8", accent2: "#c73cff", purple: "#ff85df", background: "#100610", panel: "#1d0b1d", sidebar: "#160815", text: "#fff4fd", border: "#55204f", activeMenu: "#42163d" },
  gold: { accent: "#ffc857", accent2: "#d99b22", purple: "#ffe19a", background: "#080704", panel: "#151208", sidebar: "#0e0c06", text: "#fff9e8", border: "#4b3c15", activeMenu: "#3b2f10" },
  ice: { accent: "#9fe8ff", accent2: "#52a9ff", purple: "#b7a4ff", background: "#061018", panel: "#0b1b28", sidebar: "#08151f", text: "#f4fbff", border: "#27475d", activeMenu: "#18384d" },
  forest: { accent: "#62e66f", accent2: "#239b50", purple: "#b1d96b", background: "#050b07", panel: "#0b1710", sidebar: "#07110b", text: "#f2fff3", border: "#21482d", activeMenu: "#173822" },
  mono: { accent: "#f5f5f5", accent2: "#aeb4bf", purple: "#d6d9df", background: "#050608", panel: "#101216", sidebar: "#0b0d10", text: "#ffffff", border: "#30343b", activeMenu: "#25282e" }
};

function normalizeHexColor(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : fallback;
}

function getSavedTheme() {
  try {
    return { ...THEME_DEFAULTS, ...JSON.parse(localStorage.getItem("theso-theme") || "{}") };
  } catch {
    return { ...THEME_DEFAULTS };
  }
}

function applyTheme(theme, persist = false) {
  const safe = {
    accent: normalizeHexColor(theme.accent, THEME_DEFAULTS.accent),
    accent2: normalizeHexColor(theme.accent2, THEME_DEFAULTS.accent2),
    purple: normalizeHexColor(theme.purple, THEME_DEFAULTS.purple),
    background: normalizeHexColor(theme.background, THEME_DEFAULTS.background),
    panel: normalizeHexColor(theme.panel, THEME_DEFAULTS.panel),
    sidebar: normalizeHexColor(theme.sidebar, THEME_DEFAULTS.sidebar),
    text: normalizeHexColor(theme.text, THEME_DEFAULTS.text),
    border: normalizeHexColor(theme.border, THEME_DEFAULTS.border),
    activeMenu: normalizeHexColor(theme.activeMenu, THEME_DEFAULTS.activeMenu)
  };

  const root = document.documentElement;
  root.style.setProperty("--green", safe.accent);
  root.style.setProperty("--green2", safe.accent2);
  root.style.setProperty("--purple", safe.purple);
  root.style.setProperty("--bg", safe.background);
  root.style.setProperty("--panel", safe.panel);
  root.style.setProperty("--theme-bg", safe.background);
  root.style.setProperty("--theme-panel", safe.panel);
  root.style.setProperty("--sidebar-bg", safe.sidebar);
  root.style.setProperty("--text", safe.text);
  root.style.setProperty("--line", safe.border);
  root.style.setProperty("--active-menu-bg", safe.activeMenu);

  if ($("themeAccent")) $("themeAccent").value = safe.accent;
  if ($("themeAccent2")) $("themeAccent2").value = safe.accent2;
  if ($("themePurple")) $("themePurple").value = safe.purple;
  if ($("themeBackground")) $("themeBackground").value = safe.background;
  if ($("themePanel")) $("themePanel").value = safe.panel;
  if ($("themeSidebar")) $("themeSidebar").value = safe.sidebar;
  if ($("themeText")) $("themeText").value = safe.text;
  if ($("themeBorder")) $("themeBorder").value = safe.border;
  if ($("themeActiveMenu")) $("themeActiveMenu").value = safe.activeMenu;

  if (persist) localStorage.setItem("theso-theme", JSON.stringify(safe));
}

function readThemeControls() {
  return {
    accent: $("themeAccent")?.value,
    accent2: $("themeAccent2")?.value,
    purple: $("themePurple")?.value,
    background: $("themeBackground")?.value,
    panel: $("themePanel")?.value,
    sidebar: $("themeSidebar")?.value,
    text: $("themeText")?.value,
    border: $("themeBorder")?.value,
    activeMenu: $("themeActiveMenu")?.value
  };
}

applyTheme(getSavedTheme());

["themeAccent", "themeAccent2", "themePurple", "themeBackground", "themePanel", "themeSidebar", "themeText", "themeBorder", "themeActiveMenu"].forEach(id => {
  $(id)?.addEventListener("input", () => applyTheme(readThemeControls(), true));
});

document.querySelectorAll("[data-theme-preset]").forEach(button => {
  button.addEventListener("click", () => {
    const preset = THEME_PRESETS[button.dataset.themePreset];
    if (preset) applyTheme(preset, true);
  });
});

$("resetTheme")?.addEventListener("click", () => {
  applyTheme(THEME_DEFAULTS, true);
  notify("Colores restablecidos.");
});


const savedName = localStorage.getItem("waveroom-name");
if (savedName && savedName.trim().toLowerCase() !== "david") {
  username.value = savedName;
} else {
  username.value = "USER";
  localStorage.setItem("waveroom-name", "USER");
}
refreshProfileUI();
setVoiceControls(false);
$("voiceJoinBtn").disabled = true;

// V43 · Sidebar colapsable y persistente.
(() => {
  const sidebar = document.querySelector(".sidebar");
  const collapseButton = document.querySelector(".collapse");
  if (!sidebar || !collapseButton) return;

  const STORAGE_KEY = "waveroom-sidebar-collapsed";

  function setTooltip(element, fallback) {
    if (!element) return;
    const label = fallback || element.querySelector("span")?.textContent?.trim() || element.textContent?.trim();
    if (label) {
      element.dataset.tooltip = label;
      if (!element.getAttribute("aria-label")) element.setAttribute("aria-label", label);
    }
  }

  document.querySelectorAll(".side-nav button").forEach(button => setTooltip(button));
  setTooltip(document.getElementById("openProfile"), "Perfil");

  function refreshDynamicTooltips() {
    const roomTile = document.querySelector("#roomPanel:not(.hidden) .room-tile") || document.querySelector("#roomEntry:not(.hidden) .room-tile");
    if (roomTile) {
      const roomName = roomTile.querySelector("strong")?.textContent?.trim() || "Sala";
      roomTile.dataset.tooltip = roomName;
    }

    document.querySelectorAll("#people .person").forEach(person => {
      const name = person.querySelector("strong")?.textContent?.trim() || person.textContent?.trim() || "Usuario";
      person.dataset.tooltip = name;
    });
  }

  function applySidebarState(collapsed, persist = true) {
    document.body.classList.toggle("sidebar-collapsed", collapsed);
    collapseButton.classList.toggle("is-collapsed", collapsed);
    collapseButton.title = collapsed ? "Abrir menú" : "Cerrar menú";
    collapseButton.setAttribute("aria-label", collapseButton.title);
    collapseButton.setAttribute("aria-expanded", String(!collapsed));
    if (persist) localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
    refreshDynamicTooltips();
  }

  collapseButton.addEventListener("click", () => {
    applySidebarState(!document.body.classList.contains("sidebar-collapsed"));
  });

  applySidebarState(localStorage.getItem(STORAGE_KEY) === "1", false);

  const observer = new MutationObserver(refreshDynamicTooltips);
  observer.observe(sidebar, { childList: true, subtree: true, characterData: true });
})();


/* V47 · Menú móvil y modo video/audio local */
(() => {
  const menuBtn = $("mobileMenuBtn");
  const backdrop = $("sidebarBackdrop");
  const sidebar = document.querySelector(".sidebar");
  const mediaModeBtn = $("mediaModeBtn");
  const videoStage = $("videoStage");

  const closeMobileMenu = () => {
    document.body.classList.remove("mobile-menu-open");
    backdrop?.classList.add("hidden");
    menuBtn?.setAttribute("aria-expanded", "false");
  };
  const openMobileMenu = () => {
    document.body.classList.add("mobile-menu-open");
    backdrop?.classList.remove("hidden");
    menuBtn?.setAttribute("aria-expanded", "true");
  };

  menuBtn?.addEventListener("click", () => {
    document.body.classList.contains("mobile-menu-open") ? closeMobileMenu() : openMobileMenu();
  });
  backdrop?.addEventListener("click", closeMobileMenu);
  document.querySelectorAll(".side-nav button, #leaveRoom, #copyCode").forEach(el => {
    el.addEventListener("click", () => { if (window.innerWidth <= 820) closeMobileMenu(); });
  });
  window.addEventListener("resize", () => { if (window.innerWidth > 820) closeMobileMenu(); });

  let audioOnly = localStorage.getItem("theso-media-mode") === "audio";
  const applyMediaMode = () => {
    document.body.classList.toggle("audio-only-mode", audioOnly);
    if (mediaModeBtn) {
      mediaModeBtn.textContent = audioOnly ? "🎬 Ver video" : "🎧 Solo audio";
      mediaModeBtn.setAttribute("aria-pressed", String(audioOnly));
    }
    if (videoStage) videoStage.setAttribute("data-mode", audioOnly ? "audio" : "video");
  };
  mediaModeBtn?.addEventListener("click", () => {
    audioOnly = !audioOnly;
    localStorage.setItem("theso-media-mode", audioOnly ? "audio" : "video");
    applyMediaMode();
    notify(audioOnly ? "Modo solo audio activado." : "Video visible nuevamente.");
  });
  applyMediaMode();
})();


function setSearchProvider(provider) {
  searchProvider = provider === "twitch" ? "twitch" : "youtube";
  const twitch = searchProvider === "twitch";
  $("youtubeTab")?.classList.toggle("active", !twitch);
  $("twitchTab")?.classList.toggle("active", twitch);
  $("youtubeSearchPanel")?.classList.toggle("hidden", twitch);
  $("twitchSearchPanel")?.classList.toggle("hidden", !twitch);

  const providerIcon = $("providerIcon");
  if (providerIcon) {
    providerIcon.className = `provider-icon ${twitch ? "twitch-provider" : "youtube-provider"}`;
    providerIcon.innerHTML = twitch
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 2h17v12l-5 5h-4l-3 3v-3H4V2zm2 2v13h5v2l2-2h3l3-3V4H6zm4 3h2v6h-2V7zm5 0h2v6h-2V7z"/></svg>'
      : "▶";
  }

  $("providerTitle").textContent = twitch ? "Buscar directos en Twitch" : "Buscar música en YouTube";
  $("providerSubtitle").textContent = twitch
    ? "Twitch tiene su propio buscador, resultados y reproductor."
    : "YouTube tiene su propio buscador, resultados y reproductor.";
  $("searchInput").placeholder = twitch
    ? "Buscar canal en Twitch o pegar enlace de Twitch..."
    : "Buscar canción o pegar enlace de YouTube...";
  $("searchInput").value = twitch ? ($("twitchSearchInput")?.value || "") : ($("searchMirror")?.value || "");
  localStorage.setItem("theso-active-provider", searchProvider);
}
$("youtubeTab")?.addEventListener("click",()=>setSearchProvider("youtube"));
$("twitchTab")?.addEventListener("click",()=>setSearchProvider("twitch"));

/* V75 · Pantalla de acceso: Discord o invitado */
let discordAuthenticatedUser = null;
let activeLoginMode = null;

const LOGIN_MODE_KEY = "theso-login-mode";
const GUEST_NAME_KEY = "theso-guest-name";
const GUEST_PHOTO_KEY = "theso-guest-photo";
const GUEST_BANNER_KEY = "theso-guest-banner";
const DISCORD_PROFILE_PREFIX = "theso-discord-profile-";

function discordProfileStorageKey(userId, field) {
  return `${DISCORD_PROFILE_PREFIX}${String(userId || "unknown")}-${field}`;
}

function saveDiscordProfile() {
  if (!discordAuthenticatedUser?.id) return;
  const photoKey = discordProfileStorageKey(discordAuthenticatedUser.id, "photo");
  const bannerKey = discordProfileStorageKey(discordAuthenticatedUser.id, "banner");
  try {
    // Si no hay foto personalizada, se usa de nuevo el avatar oficial de Discord.
    if (profilePhotoData && profilePhotoData !== discordAuthenticatedUser.avatar) {
      localStorage.setItem(photoKey, profilePhotoData);
    } else {
      localStorage.removeItem(photoKey);
    }
    if (profileBannerData) localStorage.setItem(bannerKey, profileBannerData);
    else localStorage.removeItem(bannerKey);
  } catch {}
}

function setLoginGateVisible(visible, message = "") {
  const gate = $("loginGate");
  if (!gate) return;
  // La interfaz inicia en modo auth-pending. Solo se revela cuando el servidor
  // confirma si existe una sesión de Discord o debe mostrarse el acceso.
  document.body.classList.remove("auth-pending");
  $("authBootSplash")?.remove();
  gate.classList.toggle("hidden", !visible);
  document.body.classList.toggle("auth-gated", visible);
  const status = $("loginGateStatus");
  if (status) {
    status.textContent = message;
    status.classList.remove("error");
  }
}

function setLoginGateError(message) {
  const status = $("loginGateStatus");
  if (!status) return;
  status.textContent = message;
  status.classList.add("error");
}

function saveGuestProfile() {
  try {
    localStorage.setItem(GUEST_NAME_KEY, getName());
    if (profilePhotoData) localStorage.setItem(GUEST_PHOTO_KEY, profilePhotoData);
    else localStorage.removeItem(GUEST_PHOTO_KEY);
    if (profileBannerData) localStorage.setItem(GUEST_BANNER_KEY, profileBannerData);
    else localStorage.removeItem(GUEST_BANNER_KEY);
  } catch {}
}

function updateSocialAccessUi() {
  const enabled = activeLoginMode === "discord";
  const friendsShortcut = $("friendsShortcut");
  if (friendsShortcut) {
    friendsShortcut.classList.toggle("hidden", !enabled);
    friendsShortcut.disabled = !enabled;
  }
  if (!enabled) {
    closeFriendsModal();
    resetPrivateChat();
    privateUnread.clear();
    updatePrivateUnreadBadge();
  }
}

function applyGuestProfile(name) {
  const previousMode = activeLoginMode;
  if (previousMode && previousMode !== "guest") leaveRoomForAccountSwitch();
  resetAccountScopedState();
  activeLoginMode = "guest";
  persistentClientId = browserGuestClientId;
  discordAuthenticatedUser = null;
  const guestName = String(name || localStorage.getItem(GUEST_NAME_KEY) || "Invitado").trim().slice(0, 30) || "Invitado";
  username.value = guestName;
  profilePhotoData = localStorage.getItem(GUEST_PHOTO_KEY) || "";
  profileBannerData = localStorage.getItem(GUEST_BANNER_KEY) || "";
  localStorage.setItem(LOGIN_MODE_KEY, "guest");
  localStorage.setItem(GUEST_NAME_KEY, guestName);
  localStorage.setItem("waveroom-name", guestName);
  if (profilePhotoData) localStorage.setItem("waveroom-photo", profilePhotoData);
  else localStorage.removeItem("waveroom-photo");
  if (profileBannerData) localStorage.setItem("waveroom-banner", profileBannerData);
  else localStorage.removeItem("waveroom-banner");
  refreshProfileUI();
  updateSocialAccessUi();
  registerIdentityAfterAccountSwitch(previousMode);
  setLoginGateVisible(false);
}

function applyDiscordProfile(user) {
  const previousMode = activeLoginMode;
  if (previousMode && previousMode !== "discord") leaveRoomForAccountSwitch();
  resetAccountScopedState();
  activeLoginMode = "discord";
  persistentClientId = `discord_${String(user.id || "").replace(/[^0-9]/g, "")}`;
  discordAuthenticatedUser = user;
  const displayName = user.displayName || user.username || "Usuario Discord";
  username.value = displayName;
  // Discord y los invitados usan perfiles separados. Las personalizaciones de
  // esta cuenta se guardan por su ID y sobreviven al cierre de sesión.
  const savedDiscordPhoto = localStorage.getItem(discordProfileStorageKey(user.id, "photo")) || "";
  const savedDiscordBanner = localStorage.getItem(discordProfileStorageKey(user.id, "banner")) || "";
  profilePhotoData = savedDiscordPhoto || user.avatar || "";
  profileBannerData = savedDiscordBanner;
  localStorage.setItem(LOGIN_MODE_KEY, "discord");
  localStorage.setItem("waveroom-name", displayName);
  if (profilePhotoData) localStorage.setItem("waveroom-photo", profilePhotoData);
  else localStorage.removeItem("waveroom-photo");
  if (profileBannerData) localStorage.setItem("waveroom-banner", profileBannerData);
  else localStorage.removeItem("waveroom-banner");
  refreshProfileUI();
  updateSocialAccessUi();
  registerIdentityAfterAccountSwitch(previousMode);
  if (currentRoom) socket.emit("update-profile", { code: currentRoom.code, ...getProfile() });
  setLoginGateVisible(false);
}

function updateDiscordCard() {
  const card = $("discordLoginCard");
  const loginButton = $("discordLoginButton");
  const logoutButton = $("discordLogoutButton");
  const title = $("discordLoginTitle");
  const status = $("discordLoginStatus");
  if (!card || !loginButton || !logoutButton) return;
  const connected = Boolean(discordAuthenticatedUser);
  card.classList.toggle("is-connected", connected);
  loginButton.classList.toggle("hidden", connected);
  logoutButton.classList.toggle("hidden", !connected);
  if (connected) {
    title.textContent = discordAuthenticatedUser.displayName || discordAuthenticatedUser.username || "Discord";
    status.textContent = `Conectado como @${discordAuthenticatedUser.username || "discord"}`;
  } else {
    title.textContent = "Cuenta de Discord";
    status.textContent = activeLoginMode === "guest"
      ? "Estás usando THESO como invitado. Puedes conectar Discord cuando quieras."
      : "Inicia sesión para usar automáticamente tu nombre y avatar.";
  }
}

async function loadDiscordSession() {
  // Mantén la pantalla de arranque mientras se consulta la sesión.
  // No reveles el login hasta confirmar que realmente no hay una cuenta activa.
  const bootStatus = document.querySelector("#authBootSplash small");
  if (bootStatus) bootStatus.textContent = "Comprobando sesión…";
  try {
    const response = await fetch("/api/auth/me", { credentials: "same-origin" });
    const data = await response.json();
    if (data.authenticated && data.user) {
      applyDiscordProfile(data.user);
    } else if (localStorage.getItem(LOGIN_MODE_KEY) === "guest" && localStorage.getItem(GUEST_NAME_KEY)) {
      applyGuestProfile();
    } else {
      activeLoginMode = null;
      setLoginGateVisible(true, "Elige una opción para entrar.");
    }
    updateDiscordCard();
  } catch (error) {
    console.warn("No se pudo comprobar la sesión de Discord:", error);
    if (localStorage.getItem(LOGIN_MODE_KEY) === "guest" && localStorage.getItem(GUEST_NAME_KEY)) {
      applyGuestProfile();
    } else {
      setLoginGateVisible(true, "No se pudo comprobar Discord. Puedes entrar como invitado.");
    }
    updateDiscordCard();
  }
}

$("showGuestLogin")?.addEventListener("click", () => {
  $("guestLoginForm")?.classList.remove("hidden");
  const input = $("guestLoginName");
  if (input) {
    input.value = localStorage.getItem(GUEST_NAME_KEY) || "";
    setTimeout(() => input.focus(), 20);
  }
});

$("guestLoginForm")?.addEventListener("submit", event => {
  event.preventDefault();
  const name = $("guestLoginName")?.value.trim();
  if (!name) return setLoginGateError("Escribe un nombre para continuar como invitado.");
  applyGuestProfile(name);
  updateDiscordCard();
  notify(`Bienvenido, ${name}.`);
});

$("discordLogoutButton")?.addEventListener("click", async () => {
  try {
    // Primero abandona cualquier sala usando todavía la identidad de Discord.
    // Después se elimina la cookie y se reconecta el socket como invitado.
    leaveRoomForAccountSwitch();
    await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
    resetAccountScopedState();
    discordAuthenticatedUser = null;
    activeLoginMode = null;
    persistentClientId = browserGuestClientId;
    localStorage.removeItem(LOGIN_MODE_KEY);
    // El socket abierto todavía fue autenticado con la cookie anterior. Se
    // reconecta ahora para que el servidor deje de tratarlo como Discord.
    if (socket.connected) {
      socket.disconnect();
      socket.connect();
    }
    updateDiscordCard();
    closeProfileModal();
    setLoginGateVisible(true, "Sesión cerrada. Elige cómo quieres entrar.");
    notify("Sesión de Discord cerrada.");
  } catch {
    notify("No se pudo cerrar la sesión de Discord.");
  }
});

(() => {
  const params = new URLSearchParams(location.search);
  const result = params.get("discord");
  if (result === "success") notify("Sesión iniciada con Discord.");
  else if (result) notify("No se pudo iniciar sesión con Discord.");
  if (result) {
    params.delete("discord");
    history.replaceState({}, "", `${location.pathname}${params.toString() ? `?${params}` : ""}${location.hash}`);
  }
  loadDiscordSession();
})();


// Presencia: actividad del usuario con límite para no saturar Socket.IO.
let lastPresenceActivitySent = 0;
function reportPresenceActivity() {
  if (!socket.connected || activeLoginMode !== "discord") return;
  const now = Date.now();
  if (now - lastPresenceActivitySent < 30000) return;
  lastPresenceActivitySent = now;
  socket.emit("presence-activity");
}
["mousemove", "keydown", "click", "touchstart"].forEach(eventName => document.addEventListener(eventName, reportPresenceActivity, { passive: true }));


// Ajuste móvil: evita que el teclado cubra el chat y mantiene controles táctiles visibles.
(function setupMobileViewport() {
  const update = () => {
    const height = window.visualViewport?.height || window.innerHeight;
    document.documentElement.style.setProperty("--theso-viewport-height", `${height}px`);
    document.body.classList.toggle("keyboard-open", Boolean(window.visualViewport && window.innerHeight - window.visualViewport.height > 140));
  };
  window.visualViewport?.addEventListener("resize", update);
  window.addEventListener("resize", update);
  update();
})();

// THESO V94: navegación inferior móvil y adaptación al teclado.
(() => {
  const nav = document.getElementById('mobileBottomNav');
  if (!nav) return;
  const buttons = [...nav.querySelectorAll('[data-mobile-action]')];
  const setActive = (button) => {
    buttons.forEach((item) => item.classList.toggle('active', item === button));
  };
  nav.addEventListener('click', (event) => {
    const button = event.target.closest('[data-mobile-action]');
    if (!button) return;
    setActive(button);
    const action = button.dataset.mobileAction;
    if (action === 'home') {
      document.getElementById('homePanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (action === 'rooms') {
      document.getElementById('focusRooms')?.click();
    } else if (action === 'chat') {
      const rail = document.getElementById('railRoomChat');
      if (rail && !rail.classList.contains('hidden')) rail.scrollIntoView({ behavior: 'smooth', block: 'start' });
      else document.getElementById('friendsShortcut')?.click();
    } else if (action === 'friends') {
      document.getElementById('friendsShortcut')?.click();
    } else if (action === 'profile') {
      document.getElementById('openProfile')?.click();
    }
  });

  const updateKeyboardState = () => {
    if (!window.visualViewport) return;
    const keyboardVisible = window.innerHeight - window.visualViewport.height > 160;
    document.body.classList.toggle('keyboard-open', keyboardVisible);
  };
  window.visualViewport?.addEventListener('resize', updateKeyboardState);
  window.visualViewport?.addEventListener('scroll', updateKeyboardState);
})();
