require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 6 * 1024 * 1024 });

const PORT = process.env.PORT || 3000;

app.use(express.json());

// Ruta de salud para Render y otros servicios de monitoreo.
app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, service: "waveroom" });
});

app.get("/api/youtube/search", async (req, res) => {
  const apiKey = process.env.YOUTUBE_API_KEY;
  const query = String(req.query.q || "").trim().slice(0, 150);

  if (!apiKey) {
    return res.status(500).json({
      error: "Falta configurar YOUTUBE_API_KEY en el servidor."
    });
  }

  if (!query) {
    return res.status(400).json({ error: "Escribe el nombre de una canción." });
  }

  try {
    const params = new URLSearchParams({
      part: "snippet",
      type: "video",
      videoCategoryId: "10",
      maxResults: "10",
      safeSearch: "moderate",
      q: query,
      key: apiKey
    });

    const response = await fetch(
      `https://www.googleapis.com/youtube/v3/search?${params.toString()}`
    );

    const data = await response.json();

    if (!response.ok) {
      const message =
        data?.error?.message || "YouTube no pudo completar la búsqueda.";
      return res.status(response.status).json({ error: message });
    }

    const results = (data.items || []).map(item => ({
      id: item.id.videoId,
      title: item.snippet.title,
      channel: item.snippet.channelTitle,
      thumbnail:
        item.snippet.thumbnails?.medium?.url ||
        item.snippet.thumbnails?.default?.url ||
        `https://i.ytimg.com/vi/${item.id.videoId}/hqdefault.jpg`
    }));

    res.json({ results });
  } catch (error) {
    console.error("Error buscando en YouTube:", error);
    res.status(500).json({ error: "No se pudo conectar con YouTube." });
  }
});


// Obtiene el título y el canal de un enlace de YouTube sin gastar cuota de búsqueda.
app.get("/api/youtube/info", async (req, res) => {
  const videoUrl = String(req.query.url || "").trim().slice(0, 500);

  if (!videoUrl) {
    return res.status(400).json({ error: "Falta el enlace de YouTube." });
  }

  try {
    const endpoint = new URL("https://www.youtube.com/oembed");
    endpoint.searchParams.set("url", videoUrl);
    endpoint.searchParams.set("format", "json");

    const response = await fetch(endpoint);
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(400).json({ error: "No se pudo leer la información del enlace." });
    }

    res.json({
      title: data.title || "Video de YouTube",
      channel: data.author_name || "YouTube",
      thumbnail: data.thumbnail_url || ""
    });
  } catch (error) {
    console.error("Error leyendo enlace de YouTube:", error);
    res.status(500).json({ error: "No se pudo consultar el enlace de YouTube." });
  }
});

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();
const PRIVATE_MESSAGES_FILE = path.join(__dirname, "private-messages.json");
let persistentPrivateChats = {};
try {
  persistentPrivateChats = JSON.parse(fs.readFileSync(PRIVATE_MESSAGES_FILE, "utf8"));
} catch { persistentPrivateChats = {}; }
let savePrivateTimer = null;
function savePersistentPrivateChats() {
  clearTimeout(savePrivateTimer);
  savePrivateTimer = setTimeout(() => {
    try { fs.writeFileSync(PRIVATE_MESSAGES_FILE, JSON.stringify(persistentPrivateChats)); }
    catch (error) { console.error("No se pudieron guardar los chats privados:", error); }
  }, 150);
}
function safeClientId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
}
function persistentChatKey(a, b) { return [safeClientId(a), safeClientId(b)].sort().join(":"); }

function sanitizeChatImage(value) {
  if (!value || typeof value !== "object") return null;
  const data = String(value.data || "");
  const name = String(value.name || "imagen").slice(0, 120);
  const allowed = /^data:image\/(png|jpeg|webp|gif);base64,/i;
  if (!allowed.test(data) || data.length > 5 * 1024 * 1024) return null;
  return { data, name };
}


function roomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 6 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

function currentRoomTime(room) {
  if (!room.playing) return room.time;
  return room.time + (Date.now() - room.updatedAt) / 1000;
}

function publicRoom(code, room) {
  return {
    code,
    hostId: room.hostId,
    users: [...room.users.entries()].map(([id, user]) => ({
      id,
      name: user.name,
      avatar: user.avatar || "",
      clientId: user.clientId || ""
    })),
    video: room.video,
    playing: room.playing,
    time: currentRoomTime(room),
    queue: room.queue,
    waitingForQueue: room.waitingForQueue,
    voiceUsers: [...(room.voiceUsers || new Set())],
    chat: room.chat.slice(-80)
  };
}

function emitRoom(code) {
  const room = rooms.get(code);
  if (room) io.to(code).emit("room-state", publicRoom(code, room));
}

function removeFromRooms(socket) {
  for (const [code, room] of rooms.entries()) {
    if (!room.users.has(socket.id)) continue;

    const leavingName = room.users.get(socket.id).name;
    room.voiceUsers?.delete(socket.id);
    room.users.delete(socket.id);
    socket.leave(code);

    if (room.users.size === 0) {
      rooms.delete(code);
      continue;
    }

    if (room.hostId === socket.id) {
      room.hostId = room.users.keys().next().value;
      io.to(room.hostId).emit("became-host");
    }

    io.to(code).emit("system-message", `${leavingName} salió de la sala.`);
    emitRoom(code);
  }
}

io.on("connection", socket => {
  socket.on("create-room", ({ name, avatar, clientId }, callback) => {
    removeFromRooms(socket);
    const code = roomCode();
    const username = String(name || "Invitado").trim().slice(0, 30);

    const room = {
      hostId: socket.id,
      users: new Map([[socket.id, { name: username, avatar: String(avatar || "").slice(0, 500000), clientId: safeClientId(clientId) || socket.id }]]),
      video: null,
      playing: false,
      time: 0,
      updatedAt: Date.now(),
      queue: [],
      waitingForQueue: false,
      voiceUsers: new Set(),
      chat: [],
      privateChats: new Map()
    };

    rooms.set(code, room);
    socket.join(code);
    callback?.({ ok: true, socketId: socket.id, room: publicRoom(code, room) });
  });

  socket.on("join-room", ({ code, name, avatar, clientId }, callback) => {
    removeFromRooms(socket);
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) return callback?.({ ok: false, error: "La sala no existe." });

    const username = String(name || "Invitado").trim().slice(0, 30);
    room.users.set(socket.id, { name: username, avatar: String(avatar || "").slice(0, 500000), clientId: safeClientId(clientId) || socket.id });
    socket.join(code);

    socket.to(code).emit("system-message", `${username} entró a la sala.`);
    callback?.({ ok: true, socketId: socket.id, room: publicRoom(code, room) });
    emitRoom(code);
  });

  socket.on("update-profile", ({ code, name, avatar, clientId }, callback) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room || !room.users.has(socket.id)) {
      return callback?.({ ok: false, error: "Sala no encontrada." });
    }

    const username = String(name || "Invitado").trim().slice(0, 30);
    room.users.set(socket.id, {
      name: username,
      avatar: String(avatar || "").slice(0, 500000),
      clientId: safeClientId(clientId) || room.users.get(socket.id)?.clientId || socket.id
    });
    emitRoom(code);
    callback?.({ ok: true });
  });

  socket.on("leave-room", ({ code }, callback) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);

    if (room?.users.has(socket.id)) {
      const username = room.users.get(socket.id).name;
      room.voiceUsers?.delete(socket.id);
      room.users.delete(socket.id);
      socket.leave(code);

      if (room.users.size === 0) {
        rooms.delete(code);
      } else {
        if (room.hostId === socket.id) {
          room.hostId = room.users.keys().next().value;
          io.to(room.hostId).emit("became-host");
        }
        io.to(code).emit("system-message", `${username} salió de la sala.`);
        emitRoom(code);
      }
    }

    callback?.({ ok: true });
  });

  socket.on("set-video", ({ code, video }, callback) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) return callback?.({ ok: false, error: "Sala no encontrada." });
    if (room.hostId !== socket.id) {
      return callback?.({ ok: false, error: "Solo el anfitrión puede cambiar el video." });
    }

    room.video = {
      id: String(video.id),
      title: String(video.title || "Video de YouTube").slice(0, 120),
      channel: String(video.channel || "YouTube").slice(0, 80),
      thumbnail: String(video.thumbnail || `https://i.ytimg.com/vi/${String(video.id)}/hqdefault.jpg`).slice(0, 500)
    };
    room.playing = true;
    room.waitingForQueue = false;
    room.time = 0;
    room.updatedAt = Date.now();

    io.to(code).emit("video-changed", {
      video: room.video,
      playing: true,
      time: 0
    });
    emitRoom(code);
    callback?.({ ok: true });
  });

  socket.on("player-action", ({ code, action, time }, callback) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) return callback?.({ ok: false, error: "Sala no encontrada." });
    if (room.hostId !== socket.id) {
      return callback?.({ ok: false, error: "Solo el anfitrión controla el video." });
    }

    const safeTime = Math.max(0, Number(time) || 0);

    if (action === "play") {
      room.time = safeTime;
      room.playing = true;
      room.waitingForQueue = false;
    } else if (action === "pause") {
      room.time = safeTime;
      room.playing = false;
    } else if (action === "seek") {
      room.time = safeTime;
    } else {
      return callback?.({ ok: false, error: "Acción inválida." });
    }

    room.updatedAt = Date.now();

    socket.to(code).emit("player-action", {
      action,
      time: safeTime,
      serverTime: Date.now()
    });

    callback?.({ ok: true });
  });

  socket.on("request-sync", ({ code }, callback) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) return callback?.({ ok: false });

    callback?.({
      ok: true,
      video: room.video,
      playing: room.playing,
      time: currentRoomTime(room)
    });
  });

  socket.on("add-queue", ({ code, video }, callback) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) return callback?.({ ok: false, error: "Sala no encontrada." });

    const item = {
      id: String(video.id),
      title: String(video.title || "Video de YouTube").slice(0, 120),
      channel: String(video.channel || "YouTube").slice(0, 80),
      thumbnail: String(video.thumbnail || `https://i.ytimg.com/vi/${String(video.id)}/hqdefault.jpg`).slice(0, 500),
      addedBy: room.users.get(socket.id)?.name || "Invitado"
    };

    // Si la canción anterior terminó con la cola vacía, la nueva canción
    // se convierte inmediatamente en la canción activa y comienza para todos.
    if (room.waitingForQueue || !room.video) {
      room.video = item;
      room.playing = true;
      room.waitingForQueue = false;
      room.time = 0;
      room.updatedAt = Date.now();

      io.to(code).emit("video-changed", {
        video: room.video,
        playing: true,
        time: 0
      });

      emitRoom(code);
      return callback?.({ ok: true, autoStarted: true });
    }

    room.queue.push(item);
    emitRoom(code);
    callback?.({ ok: true, autoStarted: false });
  });

  socket.on("next-video", ({ code }, callback) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) return callback?.({ ok: false, error: "Sala no encontrada." });
    if (room.hostId !== socket.id) {
      return callback?.({ ok: false, error: "Solo el anfitrión puede saltar." });
    }

    const video = room.queue.shift();

    if (!video) {
      // La canción terminó y no existe otra en cola. Marcamos la sala como
      // esperando música para impedir que los clientes vuelvan a reproducir
      // los últimos segundos durante la sincronización.
      room.playing = false;
      room.waitingForQueue = true;
      room.video = null;
      room.time = 0;
      room.updatedAt = Date.now();

      io.to(code).emit("queue-ended");
      emitRoom(code);
      return callback?.({ ok: true, stopped: true });
    }

    room.video = video;
    room.playing = true;
    room.waitingForQueue = false;
    room.time = 0;
    room.updatedAt = Date.now();

    io.to(code).emit("video-changed", {
      video,
      playing: true,
      time: 0
    });

    emitRoom(code);
    callback?.({ ok: true });
  });

  socket.on("voice-join", ({ code }, callback) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room || !room.users.has(socket.id)) {
      return callback?.({ ok: false, error: "Primero entra a la sala." });
    }

    room.voiceUsers ||= new Set();
    const peers = [...room.voiceUsers].filter(id => id !== socket.id);
    room.voiceUsers.add(socket.id);
    io.to(code).emit("voice-users", [...room.voiceUsers]);
    callback?.({ ok: true, peers });
  });

  socket.on("voice-signal", ({ code, target, data }, callback) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room || !room.voiceUsers?.has(socket.id) || !room.voiceUsers.has(target)) {
      return callback?.({ ok: false });
    }
    io.to(target).emit("voice-signal", { from: socket.id, data });
    callback?.({ ok: true });
  });

  socket.on("voice-mute", ({ code, muted }) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room?.voiceUsers?.has(socket.id)) return;
    io.to(code).emit("voice-muted", { id: socket.id, muted: Boolean(muted) });
  });

  socket.on("voice-leave", ({ code }, callback) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (room?.voiceUsers?.delete(socket.id)) {
      socket.to(code).emit("voice-peer-left", { id: socket.id });
      io.to(code).emit("voice-users", [...room.voiceUsers]);
    }
    callback?.({ ok: true });
  });



  socket.on("private-call-invite", ({ code, target }, callback) => {
    code = String(code || "").trim().toUpperCase(); target = String(target || "");
    const room = rooms.get(code);
    if (!room || !room.users.has(socket.id) || !room.users.has(target) || target === socket.id) return callback?.({ ok:false, error:"Usuario no disponible." });
    io.to(target).emit("private-call-invite", { from: socket.id, name: room.users.get(socket.id)?.name || "Invitado" });
    callback?.({ ok:true });
  });

  socket.on("private-call-response", ({ code, target, accepted }) => {
    code = String(code || "").trim().toUpperCase(); target = String(target || "");
    const room = rooms.get(code);
    if (!room || !room.users.has(socket.id) || !room.users.has(target)) return;
    io.to(target).emit("private-call-response", { from: socket.id, accepted: Boolean(accepted) });
  });

  socket.on("private-call-signal", ({ code, target, data }) => {
    code = String(code || "").trim().toUpperCase(); target = String(target || "");
    const room = rooms.get(code);
    if (!room || !room.users.has(socket.id) || !room.users.has(target)) return;
    io.to(target).emit("private-call-signal", { from: socket.id, data });
  });

  socket.on("private-call-end", ({ code, target }) => {
    code = String(code || "").trim().toUpperCase(); target = String(target || "");
    const room = rooms.get(code);
    if (!room || !room.users.has(socket.id) || !room.users.has(target)) return;
    io.to(target).emit("private-call-end", { from: socket.id });
  });

  socket.on("private-chat-history", ({ code, target }, callback) => {
    code = String(code || "").trim().toUpperCase();
    target = String(target || "");
    const room = rooms.get(code);
    if (!room || !room.users.has(socket.id) || !room.users.has(target) || target === socket.id) {
      return callback?.({ ok: false, error: "No se pudo abrir el chat privado." });
    }

    const me = room.users.get(socket.id);
    const other = room.users.get(target);
    const key = persistentChatKey(me?.clientId || socket.id, other?.clientId || target);
    callback?.({ ok: true, messages: persistentPrivateChats[key] || [] });
  });

  socket.on("private-chat", ({ code, target, text, image }, callback) => {
    code = String(code || "").trim().toUpperCase();
    target = String(target || "");
    const room = rooms.get(code);

    if (!room || !room.users.has(socket.id) || !room.users.has(target) || target === socket.id) {
      return callback?.({ ok: false, error: "Ese usuario ya no está disponible." });
    }

    text = String(text || "").trim().slice(0, 400);
    image = sanitizeChatImage(image);
    if (!text && !image) return callback?.({ ok: false, error: "Mensaje vacío o imagen no válida." });

    const sender = room.users.get(socket.id);
    const message = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      from: socket.id,
      to: target,
      fromClientId: sender?.clientId || socket.id,
      toClientId: room.users.get(target)?.clientId || target,
      author: sender?.name || "Invitado",
      text,
      image,
      createdAt: Date.now()
    };

    const key = persistentChatKey(message.fromClientId, message.toClientId);
    const history = persistentPrivateChats[key] || [];
    history.push(message);
    persistentPrivateChats[key] = history.slice(-150);
    savePersistentPrivateChats();

    io.to(target).emit("private-chat", message);
    socket.emit("private-chat", message);
    callback?.({ ok: true });
  });

  socket.on("chat", ({ code, text, image }, callback) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);

    if (!room || !room.users.has(socket.id)) return callback?.({ ok: false, error: "Sala no encontrada." });

    text = String(text || "").trim().slice(0, 400);
    image = sanitizeChatImage(image);
    if (!text && !image) return callback?.({ ok: false, error: "Mensaje vacío o imagen no válida." });

    const message = {
      author: room.users.get(socket.id)?.name || "Invitado",
      text,
      image,
      createdAt: Date.now()
    };

    room.chat.push(message);
    io.to(code).emit("chat", message);
    callback?.({ ok: true });
  });

  socket.on("disconnect", () => removeFromRooms(socket));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`WaveRoom YouTube iniciado en http://localhost:${PORT}`);

  if (process.env.YOUTUBE_API_KEY) {
    console.log("✅ YouTube API Key cargada correctamente.");
  } else {
    console.log("❌ No se encontró YOUTUBE_API_KEY.");
  }
});