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

let voiceStream = null;
let voiceJoined = false;
let voiceMuted = false;
const voicePeers = new Map();
const voiceMutedUsers = new Map();
const voiceUserVolumes = new Map();
const voiceAnalysers = new Map();
const speakingUsers = new Set();
let voiceMeterFrame = null;
let voiceOutputVolume = Math.max(0, Math.min(100, Number(localStorage.getItem("waveroom-voice-volume") ?? 100)));
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
  return { name: getName(), avatar: profilePhotoData };
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
    voiceUserVolumes.set(id, Math.max(0, Math.min(200, saved)));
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
  const safeValue = Math.max(0, Math.min(200, Number(value) || 0));
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
        <input type="range" min="0" max="200" value="${volume}" data-voice-user="${escapeHtml(id)}" aria-label="Volumen de ${escapeHtml(rawName)}">
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
    voiceStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });

    socket.emit("voice-join", { code: currentRoom.code }, async response => {
      if (!response?.ok) {
        voiceStream.getTracks().forEach(track => track.stop());
        voiceStream = null;
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
  voiceStream = null;
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

function addMessage(message) {
  $("messages").querySelector(".muted")?.remove();
  const div = document.createElement("div");

  if (message.author) {
    div.className = "message";
    div.innerHTML = `<strong>${escapeHtml(message.author)}</strong><p>${escapeHtml(message.text)}</p>`;
  } else {
    div.className = "system";
    div.textContent = message.text;
  }

  $("messages").appendChild(div);
  $("messages").scrollTop = $("messages").scrollHeight;
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

$("searchForm").addEventListener("submit", async event => {
  event.preventDefault();
  const query = $("searchInput").value.trim();
  $("searchMirror").value = query;

  if (!query) {
    return notify("Escribe el nombre de una canción.");
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
  const video = selectedVideo();

  if (!video) return notify("El enlace de YouTube no es válido.");
  await startSelectedVideo(video);
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
});

socket.on("connect", () => {
  mySocketId = socket.id;
  $("connectedText").textContent = "Conectado";
});

socket.on("disconnect", () => {
  $("connectedText").textContent = "Desconectado";
  leaveVoiceChat(false);
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

socket.on("chat", addMessage);
socket.on("system-message", text => addMessage({ text }));
socket.on("became-host", () => notify("Ahora eres el anfitrión."));

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
