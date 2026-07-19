const socket = io();

let player;
let playerReady = false;
let currentVideo = null;
let currentRoom = null;
let mySocketId = null;
let remoteAction = false;
let syncInterval = null;
let pendingRoomPlayback = null;
let userActivatedPlayback = sessionStorage.getItem("waveroom-playback-activated") === "1";

const $ = id => document.getElementById(id);
const username = $("username");
const toast = $("toast");
let profilePhotoData = localStorage.getItem("waveroom-photo") || "";
const persistentClientId = localStorage.getItem("waveroom-client-id") || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
localStorage.setItem("waveroom-client-id", persistentClientId);

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
const privateUnread = new Map();
const privateMessageCache = new Map();
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
  return { name: getName(), avatar: profilePhotoData, clientId: persistentClientId };
}

// Registra esta instalación del navegador en un canal persistente del servidor.
// Este registro es indispensable para que los mensajes privados lleguen en tiempo real,
// aunque el usuario no esté dentro de una sala musical.
function registerPersistentClient(callback) {
  if (!socket.connected || !persistentClientId) {
    callback?.({ ok: false, error: "Socket desconectado." });
    return;
  }

  socket.emit("register-client", {
    clientId: persistentClientId,
    name: getName(),
    avatar: profilePhotoData
  }, response => {
    if (!response?.ok) {
      console.warn("No se pudo registrar el cliente persistente:", response?.error || "Error desconocido");
    }
    callback?.(response);
  });
}

function applyAvatar(element, name = getName(), avatar = profilePhotoData) {
  if (!element) return;
  element.textContent = avatar ? "" : (name[0]?.toUpperCase() || "?");
  element.style.backgroundImage = avatar ? `url("${avatar}")` : "";
}

function refreshProfileUI() {
  $("profileName").textContent = getName();
  applyAvatar($("avatar"));
  applyAvatar($("miniAvatar"));
  applyAvatar($("profilePreview"));
}


function updateTrackUI(video) {
  const hasTrack = Boolean(video?.id);
  document.body.classList.toggle("has-track", hasTrack);
  document.body.classList.toggle("is-idle", !hasTrack);

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
  const thumb = video.thumbnail || `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`;
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

function setupEmojiPicker(buttonId, pickerId, inputId) {
  const button = $(buttonId);
  const picker = $(pickerId);
  const input = $(inputId);
  picker.innerHTML = EMOTES.map(e => `<button type="button" data-emote="${e}">${e}</button>`).join("");
  button.addEventListener("click", event => {
    event.stopPropagation();
    picker.classList.toggle("hidden");
  });
  picker.addEventListener("click", event => {
    const emote = event.target.closest("[data-emote]")?.dataset.emote;
    if (!emote) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + emote + input.value.slice(end);
    picker.classList.add("hidden");
    input.focus();
    input.setSelectionRange(start + emote.length, start + emote.length);
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

function setPrivateCallUi(active, text = "Chat privado") {
  privateCallActive = active;
  $("privateCallBtn").classList.toggle("hidden", active);
  $("privateHangupBtn").classList.toggle("hidden", !active);
  $("privateCallStatus").textContent = text;
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
  setPrivateCallUi(false, "Chat privado");
  if (!voiceJoined) { voiceStream?.getTracks().forEach(t => t.stop()); voiceRawStream?.getTracks().forEach(t => t.stop()); closeVoiceFilterGraph(); voiceStream = null; voiceRawStream = null; }
}

function openFriendsModal() {
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
  const merged = new Map(savedPrivateContacts.map(contact => [contact.clientId, { ...contact, socketId: contact.socketId || null, inRoom: false }]));
  roomUsers.forEach(user => merged.set(user.clientId, { ...(merged.get(user.clientId) || {}), ...user }));
  const users = [...merged.values()].filter(user => user.clientId && user.clientId !== persistentClientId);
  $("friendsCount").textContent = users.length;
  $("friendsList").innerHTML = users.length ? users.map(user => {
    const unread = privateUnread.get(user.clientId) || 0;
    const selected = activePrivateClientId === user.clientId;
    return `<button class="friend-row${selected ? " active" : ""}" type="button" data-friend-client="${escapeHtml(user.clientId)}">
      <span class="person-icon" style="${user.avatar ? `background-image:url('${escapeHtml(user.avatar)}')` : ""}">${user.avatar ? "" : escapeHtml(user.name?.[0]?.toUpperCase() || "?")}</span>
      <span><strong>${escapeHtml(user.name || "Usuario")}</strong><small>${user.inRoom ? (user.host ? "Anfitrión · En la sala" : "En la sala") : (user.online ? "En línea" : "Sin conexión")}</small></span>
      ${unread ? `<b class="friend-unread">${unread > 99 ? "99+" : unread}</b>` : ""}
    </button>`;
  }).join("") : '<p class="friends-empty">Tus conversaciones privadas aparecerán aquí, incluso cuando no estés en una sala.</p>';

  $("friendsList").querySelectorAll("[data-friend-client]").forEach(button => {
    button.addEventListener("click", () => openPrivateChatByClient(button.dataset.friendClient));
  });
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

    const existing = new Map(savedPrivateContacts.map(contact => [contact.clientId, contact]));
    (response.contacts || []).forEach(contact => {
      if (!contact?.clientId || contact.clientId === persistentClientId) return;
      existing.set(contact.clientId, { ...(existing.get(contact.clientId) || {}), ...contact });
    });
    savedPrivateContacts = [...existing.values()];
    renderFriendsList();
    callback?.(response);
  });
}

function renderPrivateMessages(messages = []) {
  const box = $("privateMessages");
  box.innerHTML = messages.length ? messages.map(message => {
    const mine = message.fromClientId ? message.fromClientId === persistentClientId : message.from === mySocketId;
    const time = new Date(message.createdAt || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return `<div class="private-message ${mine ? "mine" : "theirs"}">${message.text ? `<p>${escapeHtml(message.text)}</p>` : ""}${imageMessageHtml(message.image)}<small>${time}</small></div>`;
  }).join("") : '<p class="private-chat-hint">Todavía no hay mensajes. Envía el primero.</p>';
  bindChatImages(box);
  box.scrollTop = box.scrollHeight;
}

function openPrivateChatByClient(clientId) {
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
  $("privateCallStatus").textContent = activePrivateUserId && currentRoom ? "Chat privado · Disponible para llamada" : "Chat privado guardado";
  const avatar = $("privateChatAvatar");
  avatar.textContent = user.avatar ? "" : (user.name?.[0]?.toUpperCase() || "?");
  avatar.style.backgroundImage = user.avatar ? `url("${user.avatar}")` : "";
  const cachedMessages = privateMessageCache.get(clientId) || [];
  renderPrivateMessages(cachedMessages);

  socket.emit("private-chat-history-global", { clientId: persistentClientId, targetClientId: clientId }, response => {
    if (!response?.ok || activePrivateClientId !== clientId) return;
    const messages = mergePrivateMessages(clientId, response.messages || []);
    renderPrivateMessages(messages);
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
  renderFriendsList();
}

function openProfileModal() {
  $("profileModal").classList.remove("hidden");
  document.body.classList.add("modal-open");
  username.focus();
}

function closeProfileModal() {
  $("profileModal").classList.add("hidden");
  document.body.classList.remove("modal-open");
}

function resizeProfileImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("No se pudo leer la imagen."));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("La imagen no es válida."));
      image.onload = () => {
        const size = 320;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d");
        const crop = Math.min(image.width, image.height);
        const sx = (image.width - crop) / 2;
        const sy = (image.height - crop) / 2;
        context.drawImage(image, sx, sy, crop, crop, 0, 0, size, size);
        resolve(canvas.toDataURL("image/jpeg", .82));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
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

function showActivationButton() {
  $("activateAudioBtn").classList.remove("hidden");
}

function hideActivationButton() {
  $("activateAudioBtn").classList.add("hidden");
}

async function playCurrentVideo() {
  await waitForPlayer();

  try {
    player.playVideo();

    // YouTube does not throw when autoplay is blocked, so verify state shortly after.
    setTimeout(() => {
      if (
        currentVideo &&
        player.getPlayerState() !== YT.PlayerState.PLAYING
      ) {
        showActivationButton();
      } else {
        hideActivationButton();
      }
    }, 700);
  } catch {
    showActivationButton();
  }
}

async function applyRoomPlayback(video, time = 0, playing = true) {
  if (!video) return;

  pendingRoomPlayback = { video, time, playing };
  await waitForPlayer();

  remoteAction = true;
  currentVideo = video;
  updateTrackUI(video);

  if (playing) {
    player.loadVideoById({
      videoId: video.id,
      startSeconds: Math.max(0, Number(time) || 0)
    });
    await playCurrentVideo();
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
          hideActivationButton();
          userActivatedPlayback = true;
          sessionStorage.setItem("waveroom-playback-activated", "1");
        }

        if (event.data === YT.PlayerState.PAUSED || event.data === YT.PlayerState.ENDED) {
          document.body.classList.remove("is-playing");
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
  currentVideo = video;
  updateTrackUI(video);

  await waitForPlayer();

  if (autoplay) {
    player.loadVideoById({
      videoId: video.id,
      startSeconds: Math.max(0, Number(startSeconds) || 0)
    });
    await playCurrentVideo();
  } else {
    player.cueVideoById({
      videoId: video.id,
      startSeconds: Math.max(0, Number(startSeconds) || 0)
    });
  }
}

function renderRoom(room) {
  currentRoom = room;
  $("roomEntry").classList.add("hidden");
  $("roomPanel").classList.remove("hidden");
  $("roomCode").textContent = room.code;
  $("peopleCount").textContent = room.users.length;
  $("roomRole").textContent = isHost() ? "Anfitrión" : "Invitado";
  $("roleBadge").textContent = isHost() ? "Controlas la sala" : "Escuchando en sala";

  $("people").innerHTML = room.users.map(user => `
    <div class="person">
      <div class="person-icon" style="${user.avatar ? `background-image:url('${escapeHtml(user.avatar)}')` : ""}">${user.avatar ? "" : escapeHtml(user.name[0]?.toUpperCase() || "?")}</div>
      <div>
        <strong>${escapeHtml(user.name)}</strong><br>
        <span>${user.id === room.hostId ? "Anfitrión" : "Oyente"}${user.id === mySocketId ? " · Tú" : ""}</span>
      </div>
    </div>
  `).join("");

  $("queueCount").textContent = room.queue.length;
  $("chatCount").textContent = room.users.length;
  renderFriendsList();
  if (activePrivateClientId) { const active = room.users.find(user => (user.clientId || user.id) === activePrivateClientId); activePrivateUserId = active?.id || null; }
  $("queue").innerHTML = room.queue.length ? room.queue.map(video => `
    <div class="queue-item">
      <img src="${video.thumbnail || `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`}" alt="">
      <div>
        <strong>${escapeHtml(video.title)}</strong>
        <span>${escapeHtml(video.addedBy || video.channel || "YouTube")}</span>
      </div>
    </div>
  `).join("") : `<div class="empty-queue"><b>♫</b><strong>La cola está vacía</strong><p>Agrega canciones para escuchar juntos.</p></div>`;

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

function resetRoomUI() {
  leaveVoiceChat(false);
  currentRoom = null;
  $("roomEntry").classList.remove("hidden");
  $("roomPanel").classList.add("hidden");
  $("roleBadge").textContent = "Modo individual";
  $("people").innerHTML = "";
  $("queueCount").textContent = "0";
  $("chatCount").textContent = "0";
  $("queue").innerHTML = `<div class="empty-queue"><b>♫</b><strong>La cola está vacía</strong><p>Agrega canciones para escuchar juntos.</p></div>`;
  $("messages").innerHTML = `<p class="muted">Entra a una sala para conversar.</p>`;
  if (privateCallTargetId || privateCallActive) endPrivateCall(true);
  activePrivateUserId = null;
  loadPrivateConversations();
  delete $("messages").dataset.loaded;
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
      // La clase se actualiza directamente para no reconstruir los controles mientras se arrastran.
    }
    if (voiceAnalysers.size) voiceMeterFrame = requestAnimationFrame(tick);
    else voiceMeterFrame = null;
  };
  voiceMeterFrame = requestAnimationFrame(tick);
}

function setVoiceControls(joined) {
  voiceJoined = joined;
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
  const box = $("messages");
  if (!box) return;
  const move = () => {
    try {
      box.scrollTo({ top: box.scrollHeight, behavior });
    } catch (_) {
      box.scrollTop = box.scrollHeight;
    }
  };
  requestAnimationFrame(() => {
    move();
    requestAnimationFrame(move);
  });
}

function addMessage(message) {
  $("messages").querySelector(".muted")?.remove();
  const div = document.createElement("div");

  if (message.author) {
    div.className = "message";
    div.innerHTML = `<strong>${escapeHtml(message.author)}</strong>${message.text ? `<p>${escapeHtml(message.text)}</p>` : ""}${imageMessageHtml(message.image)}`;
    bindChatImages(div);
    div.querySelectorAll("img").forEach(img => {
      if (!img.complete) img.addEventListener("load", () => scrollRoomChatToBottom("auto"), { once: true });
    });
  } else {
    div.className = "system";
    div.textContent = message.text;
  }

  $("messages").appendChild(div);
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
          $("videoTitle").value = video.title;

          await startSelectedVideo(video);
        });
      });
  } catch (error) {
    status.textContent = error.message;
    resultsContainer.innerHTML =
      `<div class="search-empty">${escapeHtml(error.message)}</div>`;
  }
}

async function videoFromYouTubeLink(value, optionalTitle = "") {
  const id = parseYouTubeId(value);
  if (!id) return null;

  const fallback = {
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

$("searchForm").addEventListener("submit", async event => {
  event.preventDefault();
  const query = $("searchInput").value.trim();
  $("searchMirror").value = query;

  if (!query) {
    return notify("Escribe el nombre de una canción o pega un enlace de YouTube.");
  }

  // Si se pega un enlace en el buscador, se agrega directamente a la cola.
  if (parseYouTubeId(query)) {
    const added = await addYouTubeLinkDirectlyToQueue(query);
    if (added) {
      $("searchStatus").textContent = "Enlace agregado directamente a la cola.";
      $("searchResults").innerHTML = "";
      $("searchInput").value = "";
      $("searchMirror").value = "";
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
    title: $("videoTitle").value.trim() || "Video de YouTube"
  };
}

$("videoForm").addEventListener("submit", async event => {
  event.preventDefault();
  const url = $("youtubeUrl").value.trim();
  const title = $("videoTitle").value.trim();
  const added = await addYouTubeLinkDirectlyToQueue(url, title);

  if (added) {
    $("youtubeUrl").value = "";
    $("videoTitle").value = "";
    $("searchStatus").textContent = "Enlace agregado directamente a la cola.";
  }
});

$("playBtn").addEventListener("click", async () => {
  if (!currentVideo) return notify("Primero selecciona un video.");
  if (currentRoom && !isHost()) return notify("Solo el anfitrión controla la reproducción.");

  userActivatedPlayback = true;
  sessionStorage.setItem("waveroom-playback-activated", "1");
  await playCurrentVideo();
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

$("pauseBtn").addEventListener("click", () => {
  if (!playerReady) return;
  if (currentRoom && !isHost()) return notify("Solo el anfitrión controla la reproducción.");
  player.pauseVideo();
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
  if (!isHost()) return notify("Solo el anfitrión puede saltar.");

  socket.emit("next-video", { code: currentRoom.code }, response => {
    if (!response?.ok) notify(response?.error);
  });
}

$("nextBtn").addEventListener("click", nextVideo);

$("createRoom").addEventListener("click", () => {
  socket.emit("create-room", getProfile(), response => {
    if (!response?.ok) return notify(response?.error);
    mySocketId = response.socketId;
    renderRoom(response.room);
    notify(`Sala ${response.room.code} creada.`);
  });
});

$("joinRoom").addEventListener("click", () => {
  const code = $("roomCodeInput").value.trim().toUpperCase();
  if (!code) return notify("Escribe el código.");

  socket.emit("join-room", { code, ...getProfile() }, async response => {
    if (!response?.ok) return notify(response?.error);

    mySocketId = response.socketId;
    renderRoom(response.room);

    // Always load the active room video after entering, even if the player
    // is still initializing. This removes the old default-video problem.
    if (response.room.video) {
      pendingRoomPlayback = {
        video: response.room.video,
        time: response.room.time || 0,
        playing: response.room.playing
      };

      try {
        await applyRoomPlayback(
          response.room.video,
          response.room.time || 0,
          response.room.playing
        );
      } catch {
        notify("El reproductor todavía está cargando.");
      }
    }

    notify(`Entraste a ${response.room.code}.`);
  });
});

$("leaveRoom").addEventListener("click", () => {
  if (!currentRoom) return;
  socket.emit("leave-room", { code: currentRoom.code }, () => {
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
  });
});

$("focusRooms").addEventListener("click", () => {
  $("rooms").scrollIntoView({ behavior: "smooth" });
});

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

setupEmojiPicker("roomEmojiBtn", "roomEmojiPicker", "chatInput");
setupEmojiPicker("privateEmojiBtn", "privateEmojiPicker", "privateChatInput");
$("roomImageBtn").addEventListener("click", () => $("roomImageInput").click());
$("privateImageBtn").addEventListener("click", () => $("privateImageInput").click());
$("roomImageInput").addEventListener("change", event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) sendRoomImage(file); });
$("privateImageInput").addEventListener("change", event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) sendPrivateImage(file); });
$("chatInput").addEventListener("paste", event => { const file = [...(event.clipboardData?.files || [])].find(f => f.type.startsWith("image/")); if (file) { event.preventDefault(); sendRoomImage(file); } });
$("privateChatInput").addEventListener("paste", event => { const file = [...(event.clipboardData?.files || [])].find(f => f.type.startsWith("image/")); if (file) { event.preventDefault(); sendPrivateImage(file); } });
for (const [zoneId, sender] of [["messages", sendRoomImage], ["privateMessages", sendPrivateImage]]) {
  const zone = $(zoneId);
  zone.addEventListener("dragover", event => { event.preventDefault(); zone.classList.add("drop-active"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("drop-active"));
  zone.addEventListener("drop", event => { event.preventDefault(); zone.classList.remove("drop-active"); const file = [...event.dataTransfer.files].find(f => f.type.startsWith("image/")); if (file) sender(file); });
}
$("closeImageViewer").addEventListener("click", () => $("imageViewer").classList.add("hidden"));
$("imageViewer").addEventListener("click", event => { if (event.target === $("imageViewer")) $("imageViewer").classList.add("hidden"); });
$("privateCallBtn").addEventListener("click", startPrivateCall);
$("privateHangupBtn").addEventListener("click", () => endPrivateCall(true));
$("acceptPrivateCall").addEventListener("click", acceptPrivateCallInvite);
$("rejectPrivateCall").addEventListener("click", rejectPrivateCallInvite);

$("privateChatForm").addEventListener("submit", event => {
  event.preventDefault();
  if (!activePrivateClientId) return notify("Selecciona una conversación privada.");
  const input = $("privateChatInput");
  const text = input.value.trim();
  if (!text) return;
  const targetClientId = activePrivateClientId;
  socket.emit("private-chat-global", { clientId: persistentClientId, targetClientId, text }, response => {
    if (!response?.ok) return notify(response?.error || "No se pudo enviar el mensaje privado.");
    input.value = "";
    // Refresca inmediatamente el historial del remitente, incluso si el evento
    // de Socket.IO tarda unos milisegundos o la conexión acaba de recuperarse.
    socket.emit("private-chat-history-global", { clientId: persistentClientId, targetClientId }, history => {
      if (history?.ok && activePrivateClientId === targetClientId) renderPrivateMessages(history.messages || []);
    });
  });
});

$("openProfile").addEventListener("click", openProfileModal);
$("closeProfile").addEventListener("click", closeProfileModal);
$("cancelProfile").addEventListener("click", closeProfileModal);
$("profileModal").querySelector("[data-close-profile]").addEventListener("click", closeProfileModal);

$("profilePhoto").addEventListener("change", async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    event.target.value = "";
    return notify("La foto debe pesar menos de 2 MB.");
  }

  try {
    profilePhotoData = await resizeProfileImage(file);
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

username.addEventListener("input", () => {
  applyAvatar($("profilePreview"), getName(), profilePhotoData);
});

$("profileForm").addEventListener("submit", event => {
  event.preventDefault();
  const name = getName();
  username.value = name;
  localStorage.setItem("waveroom-name", name);
  if (profilePhotoData) localStorage.setItem("waveroom-photo", profilePhotoData);
  else localStorage.removeItem("waveroom-photo");
  refreshProfileUI();
setVoiceControls(false);
$("voiceJoinBtn").disabled = true;

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
  if (event.key === "Escape" && !$("profileModal").classList.contains("hidden")) closeProfileModal();
  if (event.key === "Escape" && !$("friendsModal").classList.contains("hidden")) closeFriendsModal();
});

socket.on("connect", () => {
  mySocketId = socket.id;
  $("connectedText").textContent = "Conectado";

  // Primero se une el socket al canal client:<id>. Solo después se cargan
  // conversaciones e historial, evitando la carrera que impedía recibir mensajes
  // hasta que el destinatario enviaba uno.
  registerPersistentClient(() => {
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

socket.on("room-state", room => {
  if (currentRoom?.code === room.code) renderRoom(room);
});

socket.on("video-changed", async ({ video, playing, time }) => {
  await applyRoomPlayback(video, time || 0, playing);
});

socket.on("queue-ended", () => {
  if (!playerReady) return;

  remoteAction = true;
  hideActivationButton();

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


socket.on("private-call-invite", ({ from, name }) => {
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
socket.on("private-message-notification", message => {
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
  if (!message) return;
  const otherClientId = message.fromClientId === persistentClientId ? message.toClientId : message.fromClientId;
  const messages = mergePrivateMessages(otherClientId, [message]);
  const privateChatIsOpen = activePrivateClientId === otherClientId && !$("friendsModal").classList.contains("hidden");

  // Se pinta directamente desde el mensaje recibido, sin esperar otra escritura
  // ni una segunda consulta al servidor. Después se sincroniza el historial.
  if (privateChatIsOpen) {
    renderPrivateMessages(messages);
    socket.emit("private-chat-history-global", { clientId: persistentClientId, targetClientId: otherClientId }, response => {
      if (!response?.ok || activePrivateClientId !== otherClientId) return;
      renderPrivateMessages(mergePrivateMessages(otherClientId, response.messages || []));
    });
  }
  loadPrivateConversations();
});

socket.on("chat", addMessage);
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
$("profileShortcut").addEventListener("click", openProfileModal);
$("miniProfile").addEventListener("click", openProfileModal);
$("focusSearch").addEventListener("click", () => $("searchSection").scrollIntoView({ behavior: "smooth" }));

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
  paintRange($("voiceVolumeBar"));
  localStorage.setItem("waveroom-voice-volume", String(voiceOutputVolume));
  for (const id of voicePeers.keys()) applyVoiceVolume(id);
  document.querySelectorAll("#remoteAudios audio").forEach(audio => {
    audio.volume = voiceOutputVolume / 100;
  });
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

const savedName = localStorage.getItem("waveroom-name");
if (savedName) username.value = savedName;
refreshProfileUI();
setVoiceControls(false);
$("voiceJoinBtn").disabled = true;
