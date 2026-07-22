require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Server } = require("socket.io");
const db = require("./database");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 6 * 1024 * 1024 });

const PORT = process.env.PORT || 3000;

app.use(express.json());

app.set("trust proxy", 1);

const DISCORD_COOKIE_NAME = "theso_discord_session";
const DISCORD_STATE_COOKIE = "theso_discord_state";
const DISCORD_SESSION_MAX_AGE = 30 * 24 * 60 * 60;

function discordSessionSecret() {
  return process.env.SESSION_SECRET || process.env.DISCORD_CLIENT_SECRET || "";
}

function parseCookies(req) {
  const cookies = {};
  String(req.headers.cookie || "").split(";").forEach(part => {
    const index = part.indexOf("=");
    if (index < 0) return;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  });
  return cookies;
}

function signCookieValue(value) {
  const secret = discordSessionSecret();
  if (!secret) return "";
  const signature = crypto.createHmac("sha256", secret).update(value).digest("base64url");
  return `${value}.${signature}`;
}

function verifyCookieValue(signedValue) {
  const secret = discordSessionSecret();
  if (!secret || !signedValue) return null;
  const separator = signedValue.lastIndexOf(".");
  if (separator < 1) return null;
  const value = signedValue.slice(0, separator);
  const signature = signedValue.slice(separator + 1);
  const expected = crypto.createHmac("sha256", secret).update(value).digest("base64url");
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  } catch { return null; }
  return value;
}

function setCookie(res, name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (process.env.NODE_ENV === "production" || process.env.RENDER) parts.push("Secure");
  if (options.maxAge != null) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  res.append("Set-Cookie", parts.join("; "));
}

function clearCookie(res, name) {
  setCookie(res, name, "", { maxAge: 0 });
}

function getDiscordRedirectUri(req) {
  if (process.env.DISCORD_REDIRECT_URI) return process.env.DISCORD_REDIRECT_URI;
  return `${req.protocol}://${req.get("host")}/auth/discord/callback`;
}

function readDiscordUser(req) {
  const signed = parseCookies(req)[DISCORD_COOKIE_NAME];
  const payload = verifyCookieValue(signed);
  if (!payload) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!parsed?.id || !parsed?.expiresAt || Date.now() > parsed.expiresAt) return null;
    return parsed;
  } catch { return null; }
}

app.get("/auth/discord", (req, res) => {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret || !discordSessionSecret()) {
    return res.status(503).send("Discord Login no está configurado en el servidor.");
  }

  const state = crypto.randomBytes(24).toString("base64url");
  setCookie(res, DISCORD_STATE_COOKIE, signCookieValue(state), { maxAge: 10 * 60 });
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: getDiscordRedirectUri(req),
    scope: "identify",
    state
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

app.get("/auth/discord/callback", async (req, res) => {
  const code = String(req.query.code || "");
  const state = String(req.query.state || "");
  const savedState = verifyCookieValue(parseCookies(req)[DISCORD_STATE_COOKIE]);
  clearCookie(res, DISCORD_STATE_COOKIE);

  if (!code || !state || !savedState || state !== savedState) {
    return res.redirect("/?discord=error_state");
  }

  try {
    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: getDiscordRedirectUri(req)
      })
    });
    const token = await tokenResponse.json();
    if (!tokenResponse.ok || !token.access_token) throw new Error(token.error_description || "No se pudo obtener el token de Discord.");

    const userResponse = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });
    const user = await userResponse.json();
    if (!userResponse.ok || !user.id) throw new Error(user.message || "No se pudo leer el perfil de Discord.");

    const displayName = String(user.global_name || user.username || "Usuario Discord").slice(0, 30);
    const avatar = user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${String(user.avatar).startsWith("a_") ? "gif" : "png"}?size=256`
      : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(user.id) >> 22n) % 6}.png`;
    const sessionUser = {
      id: String(user.id),
      username: String(user.username || ""),
      displayName,
      avatar,
      expiresAt: Date.now() + DISCORD_SESSION_MAX_AGE * 1000
    };
    const payload = Buffer.from(JSON.stringify(sessionUser)).toString("base64url");
    setCookie(res, DISCORD_COOKIE_NAME, signCookieValue(payload), { maxAge: DISCORD_SESSION_MAX_AGE });
    res.redirect("/?discord=success");
  } catch (error) {
    console.error("Error en Discord OAuth:", error);
    res.redirect("/?discord=error");
  }
});

app.get("/api/auth/me", (req, res) => {
  const user = readDiscordUser(req);
  res.json({ authenticated: Boolean(user), user: user ? {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatar: user.avatar
  } : null });
});

app.get("/api/database/status", (_req, res) => {
  res.json({ connected: db.isMongoReady(), provider: "MongoDB Atlas" });
});

app.post("/auth/logout", (_req, res) => {
  clearCookie(res, DISCORD_COOKIE_NAME);
  res.json({ ok: true });
});


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


let twitchTokenCache = { token: "", expiresAt: 0 };
async function getTwitchToken() {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Faltan TWITCH_CLIENT_ID y TWITCH_CLIENT_SECRET.");
  if (twitchTokenCache.token && Date.now() < twitchTokenCache.expiresAt) return twitchTokenCache.token;
  const params = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" });
  const response = await fetch(`https://id.twitch.tv/oauth2/token?${params}`, { method: "POST" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "No se pudo autenticar con Twitch.");
  twitchTokenCache = { token: data.access_token, expiresAt: Date.now() + Math.max(60, data.expires_in - 120) * 1000 };
  return data.access_token;
}

app.get("/api/twitch/search", async (req, res) => {
  const query = String(req.query.q || "").trim().slice(0, 100);
  if (!query) return res.status(400).json({ error: "Escribe el nombre de un canal." });
  try {
    const token = await getTwitchToken();
    const headers = { "Client-ID": process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` };
    const channelsResponse = await fetch(`https://api.twitch.tv/helix/search/channels?query=${encodeURIComponent(query)}&first=12&live_only=true`, { headers });
    const channels = await channelsResponse.json();
    if (!channelsResponse.ok) return res.status(channelsResponse.status).json({ error: channels.message || "Twitch no pudo completar la búsqueda." });
    const names = (channels.data || []).map(item => item.broadcaster_login).filter(Boolean);
    let streamMap = new Map();
    if (names.length) {
      const params = new URLSearchParams(); names.forEach(name => params.append("user_login", name));
      const streamsResponse = await fetch(`https://api.twitch.tv/helix/streams?${params}`, { headers });
      const streams = await streamsResponse.json();
      streamMap = new Map((streams.data || []).map(item => [item.user_login.toLowerCase(), item]));
    }
    const results = (channels.data || []).filter(item => item.is_live).map(item => {
      const stream = streamMap.get(String(item.broadcaster_login).toLowerCase()) || {};
      return { provider: "twitch", id: item.broadcaster_login, title: stream.title || item.title || `${item.display_name} en directo`, channel: item.display_name, category: stream.game_name || item.game_name || "Twitch", viewers: stream.viewer_count || 0, thumbnail: (stream.thumbnail_url || item.thumbnail_url || "").replace("{width}", "640").replace("{height}", "360"), live: true };
    });
    res.json({ results });
  } catch (error) {
    res.status(500).json({ error: error.message || "No se pudo conectar con Twitch." });
  }
});

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();
const connectedClients = new Map(); // clientId -> { socketId, name, avatar, banner }
const socketClients = new Map(); // socketId -> clientId
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
function getContactMeta(clientId) {
  const live = connectedClients.get(clientId);
  const saved = persistentPrivateChats.__contacts?.[clientId] || {};
  return {
    clientId,
    socketId: live?.socketId || null,
    name: live?.name || saved.name || "Usuario",
    avatar: live?.avatar || saved.avatar || "",
    banner: live?.banner || saved.banner || "",
    online: Boolean(live)
  };
}
function rememberContact(clientId, name, avatar, banner = "") {
  if (!clientId) return;
  persistentPrivateChats.__contacts ||= {};
  persistentPrivateChats.__contacts[clientId] = {
    name: String(name || "Usuario").slice(0, 30),
    avatar: String(avatar || "").slice(0, 3 * 1024 * 1024),
    banner: String(banner || "").slice(0, 3 * 1024 * 1024)
  };
  savePersistentPrivateChats();
}

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

  // Cada creación genera un código nuevo con aleatoriedad criptográfica.
  // También se comprueba contra todas las salas activas antes de devolverlo.
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    let code = "";
    for (let i = 0; i < 6; i += 1) {
      code += chars[crypto.randomInt(0, chars.length)];
    }

    if (!rooms.has(code)) return code;
  }

  // Respaldo extremadamente improbable: aumenta la longitud del código.
  let fallback;
  do {
    fallback = crypto.randomBytes(8).toString("hex").slice(0, 8).toUpperCase();
  } while (rooms.has(fallback));
  return fallback;
}

function currentRoomTime(room) {
  if (!room.playing) return room.time;
  return room.time + (Date.now() - room.updatedAt) / 1000;
}

function publicRoom(code, room) {
  return {
    code,
    hostId: room.hostId,
    visibility: room.visibility || "public",
    roomName: room.roomName || `Sala de ${room.users.get(room.hostId)?.name || "Usuario"}`,
    users: [...room.users.entries()].map(([id, user]) => ({
      id,
      name: user.name,
      avatar: user.avatar || "",
      banner: user.banner || "",
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

function roomDirectory() {
  return [...rooms.entries()].map(([code, room]) => ({
    code: room.visibility === "private" ? null : code,
    visibility: room.visibility || "public",
    roomName: room.roomName || `Sala de ${room.users.get(room.hostId)?.name || "Usuario"}`,
    hostName: room.users.get(room.hostId)?.name || "Usuario",
    userCount: room.users.size,
    users: [...room.users.values()].map(user => ({
      name: user.name,
      avatar: user.avatar || ""
    }))
  })).sort((a, b) => Number(b.visibility === "public") - Number(a.visibility === "public") || b.userCount - a.userCount);
}

function broadcastRoomDirectory() {
  io.emit("rooms-list", roomDirectory());
}

function emitRoom(code) {
  const room = rooms.get(code);
  if (room) io.to(code).emit("room-state", publicRoom(code, room));
  broadcastRoomDirectory();
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
      broadcastRoomDirectory();
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
  const discordSession = readDiscordUser(socket.request);
  const authenticatedIdentityId = discordSession?.id ? `discord_${safeClientId(discordSession.id)}` : "";
  socket.data.discordSession = discordSession || null;
  socket.data.identityId = authenticatedIdentityId;
  socket.emit("rooms-list", roomDirectory());
  socket.on("list-rooms", (_payload, callback) => callback?.({ ok: true, rooms: roomDirectory() }));
  socket.on("register-client", async ({ clientId, name, avatar, banner } = {}, callback) => {
    try {
      clientId = authenticatedIdentityId || safeClientId(clientId);
      if (!clientId) return callback?.({ ok: false, error: "Identidad no válida." });

      const previousClientId = socketClients.get(socket.id);
      if (previousClientId && previousClientId !== clientId) {
        socket.leave(`client:${previousClientId}`);
        const previousProfile = connectedClients.get(previousClientId);
        if (previousProfile?.socketId === socket.id) connectedClients.delete(previousClientId);
      }

      const profile = {
        socketId: socket.id,
        name: String(name || discordSession?.displayName || "Usuario").trim().slice(0, 30),
        avatar: String(avatar || discordSession?.avatar || "").slice(0, 3 * 1024 * 1024),
        banner: String(banner || "").slice(0, 3 * 1024 * 1024),
        authenticated: Boolean(authenticatedIdentityId)
      };
      connectedClients.set(clientId, profile);
      socketClients.set(socket.id, clientId);
      socket.data.identityId = clientId;
      socket.join(`client:${clientId}`);
      rememberContact(clientId, profile.name, profile.avatar, profile.banner);
      if (authenticatedIdentityId && discordSession) {
        await db.upsertDiscordUser(clientId, discordSession, profile);
      }
      callback?.({ ok: true, clientId, authenticated: Boolean(authenticatedIdentityId), database: db.isMongoReady() });
    } catch (error) {
      console.error("Error registrando cliente:", error);
      callback?.({ ok: false, error: "No se pudo registrar tu cuenta.", database: db.isMongoReady() });
    }
  });

  socket.on("friend-state", async (_payload = {}, callback) => {
    try {
      const clientId = socketClients.get(socket.id);
      if (!authenticatedIdentityId || clientId !== authenticatedIdentityId) {
        return callback?.({ ok: false, error: "Inicia sesión con Discord para usar amigos permanentes.", database: db.isMongoReady(), friends: [], incoming: [], outgoing: [] });
      }
      const state = await db.getFriendState(clientId);
      const decorate = item => ({ ...item, ...getContactMeta(item.clientId), online: Boolean(connectedClients.get(item.clientId)) });
      callback?.({ ok: true, database: db.isMongoReady(), friends: state.friends.map(decorate), incoming: state.incoming.map(decorate), outgoing: state.outgoing.map(decorate) });
    } catch (error) {
      callback?.({ ok: false, error: error.message || "No se pudieron cargar tus amigos.", database: db.isMongoReady(), friends: [], incoming: [], outgoing: [] });
    }
  });

  socket.on("friend-request-send", async ({ targetClientId } = {}, callback) => {
    try {
      const senderId = socketClients.get(socket.id);
      targetClientId = safeClientId(targetClientId);
      if (!authenticatedIdentityId || senderId !== authenticatedIdentityId) throw new Error("Inicia sesión con Discord para enviar solicitudes.");
      if (!targetClientId.startsWith("discord_")) throw new Error("Ese usuario debe iniciar sesión con Discord.");
      const result = await db.sendFriendRequest(senderId, targetClientId);
      if (result.reverseRequest) {
        const accepted = await db.respondFriendRequest(String(result.reverseRequest._id), senderId, true);
        io.to(`client:${targetClientId}`).emit("friend-state-changed", { type: "accepted", by: senderId });
        socket.emit("friend-state-changed", { type: "accepted", by: targetClientId });
        return callback?.({ ok: true, accepted: true, message: "Solicitud cruzada aceptada: ahora son amigos." });
      }
      const sender = getContactMeta(senderId);
      io.to(`client:${targetClientId}`).emit("friend-request-received", { requestId: String(result.request._id), clientId: senderId, name: sender.name, avatar: sender.avatar });
      callback?.({ ok: true, message: "Solicitud de amistad enviada." });
    } catch (error) {
      callback?.({ ok: false, error: error.message || "No se pudo enviar la solicitud." });
    }
  });

  socket.on("friend-request-respond", async ({ requestId, accept } = {}, callback) => {
    try {
      const receiverId = socketClients.get(socket.id);
      if (!authenticatedIdentityId || receiverId !== authenticatedIdentityId) throw new Error("Inicia sesión con Discord.");
      const request = await db.respondFriendRequest(String(requestId || ""), receiverId, Boolean(accept));
      io.to(`client:${request.senderId}`).emit("friend-state-changed", { type: accept ? "accepted" : "rejected", by: receiverId });
      socket.emit("friend-state-changed", { type: accept ? "accepted" : "rejected", by: request.senderId });
      callback?.({ ok: true, accepted: Boolean(accept) });
    } catch (error) {
      callback?.({ ok: false, error: error.message || "No se pudo responder la solicitud." });
    }
  });

  socket.on("private-conversations", async (_payload = {}, callback) => {
    try {
      const clientId = socketClients.get(socket.id);
      if (!clientId) return callback?.({ ok: false, error: "Identidad no válida." });
      if (!authenticatedIdentityId || clientId !== authenticatedIdentityId) {
        return callback?.({ ok: false, error: "Los invitados no pueden usar conversaciones privadas." });
      }
      if (db.isMongoReady()) {
        const [state, conversationContacts] = await Promise.all([db.getFriendState(clientId), db.getConversationContacts(clientId)]);
        const merged = new Map();
        [...state.friends, ...conversationContacts].forEach(contact => merged.set(contact.clientId, { ...contact, ...getContactMeta(contact.clientId) }));
        return callback?.({ ok: true, contacts: [...merged.values()] });
      }
      return callback?.({ ok: false, error: "MongoDB Atlas no está disponible." });
    } catch (error) {
      callback?.({ ok: false, error: "No se pudieron cargar las conversaciones." });
    }
  });

  socket.on("private-chat-history-global", async ({ targetClientId } = {}, callback) => {
    try {
      const clientId = socketClients.get(socket.id);
      targetClientId = safeClientId(targetClientId);
      if (!authenticatedIdentityId || clientId !== authenticatedIdentityId) return callback?.({ ok: false, error: "Los invitados no pueden abrir chats privados." });
      if (!clientId || !targetClientId || clientId === targetClientId || !targetClientId.startsWith("discord_")) return callback?.({ ok: false, error: "No se pudo abrir el chat privado." });
      if (db.isMongoReady()) {
        if (!(await db.areFriends(clientId, targetClientId))) return callback?.({ ok: false, error: "Deben ser amigos para conservar este chat." });
        const messages = await db.getMessages(clientId, targetClientId, 150);
        const contacts = new Map([getContactMeta(clientId), getContactMeta(targetClientId)].map(x => [x.clientId, x]));
        messages.forEach(message => { message.author = contacts.get(message.fromClientId)?.name || "Usuario"; });
        return callback?.({ ok: true, messages });
      }
      callback?.({ ok: false, error: "MongoDB Atlas no está disponible." });
    } catch (error) {
      callback?.({ ok: false, error: error.message || "No se pudo cargar el historial." });
    }
  });

  socket.on("private-chat-global", async ({ targetClientId, text, image } = {}, callback) => {
    try {
      const clientId = socketClients.get(socket.id);
      targetClientId = safeClientId(targetClientId);
      if (!authenticatedIdentityId || clientId !== authenticatedIdentityId) return callback?.({ ok: false, error: "Los invitados no pueden enviar mensajes privados." });
      if (!clientId || !targetClientId || clientId === targetClientId || !targetClientId.startsWith("discord_")) return callback?.({ ok: false, error: "Conversación no válida." });
      text = String(text || "").trim().slice(0, 400);
      image = sanitizeChatImage(image);
      if (!text && !image) return callback?.({ ok: false, error: "Mensaje vacío o imagen no válida." });
      const senderMeta = getContactMeta(clientId);
      const targetMeta = getContactMeta(targetClientId);
      let message;
      if (db.isMongoReady()) {
        if (!(await db.areFriends(clientId, targetClientId))) return callback?.({ ok: false, error: "Primero deben aceptar la solicitud de amistad." });
        message = await db.saveMessage(clientId, targetClientId, text, image, senderMeta.name);
      } else {
        return callback?.({ ok: false, error: "MongoDB Atlas no está disponible." });
      }
      io.to(`client:${targetClientId}`).emit("private-message-notification", message);
      io.to(`client:${targetClientId}`).emit("private-chat-global", message);
      socket.emit("private-chat-global", message);
      callback?.({ ok: true, message });
    } catch (error) {
      callback?.({ ok: false, error: error.message || "No se pudo enviar el mensaje." });
    }
  });
  socket.on("room-invite", ({ targetClientId, code } = {}, callback) => {
    const senderClientId = safeClientId(socketClients.get(socket.id));
    targetClientId = safeClientId(targetClientId);
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!senderClientId || !targetClientId || !room || !room.users.has(socket.id)) {
      return callback?.({ ok: false, error: "No se pudo enviar la invitación." });
    }
    const sender = room.users.get(socket.id);
    io.to(`client:${targetClientId}`).emit("room-invite", {
      code,
      roomName: room.roomName || `Sala de ${sender?.name || "Usuario"}`,
      visibility: room.visibility || "public",
      fromClientId: senderClientId,
      fromName: sender?.name || "Usuario"
    });
    callback?.({ ok: true });
  });

  socket.on("create-room", ({ name, avatar, banner, clientId, visibility, roomName }, callback) => {
    removeFromRooms(socket);
    const code = roomCode();
    const username = String(name || "Invitado").trim().slice(0, 30);

    visibility = visibility === "private" ? "private" : "public";
    roomName = String(roomName || `Sala de ${username}`).trim().slice(0, 40);

    const room = {
      hostId: socket.id,
      visibility,
      roomName,
      users: new Map([[socket.id, {
        name: username,
        avatar: String(avatar || "").slice(0, 3 * 1024 * 1024),
        banner: String(banner || "").slice(0, 3 * 1024 * 1024),
        clientId: safeClientId(clientId) || socket.id
      }]]),
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
    broadcastRoomDirectory();
  });

  socket.on("join-room", ({ code, name, avatar, banner, clientId }, callback) => {
    removeFromRooms(socket);
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) return callback?.({ ok: false, error: "La sala no existe." });

    const username = String(name || "Invitado").trim().slice(0, 30);
    room.users.set(socket.id, {
      name: username,
      avatar: String(avatar || "").slice(0, 3 * 1024 * 1024),
      banner: String(banner || "").slice(0, 3 * 1024 * 1024),
      clientId: safeClientId(clientId) || socket.id
    });
    socket.join(code);

    socket.to(code).emit("system-message", `${username} entró a la sala.`);
    callback?.({ ok: true, socketId: socket.id, room: publicRoom(code, room) });
    emitRoom(code);
  });

  socket.on("update-profile", ({ code, name, avatar, banner, clientId }, callback) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room || !room.users.has(socket.id)) {
      return callback?.({ ok: false, error: "Sala no encontrada." });
    }

    const username = String(name || "Invitado").trim().slice(0, 30);
    room.users.set(socket.id, {
      name: username,
      avatar: String(avatar || "").slice(0, 3 * 1024 * 1024),
      banner: String(banner || "").slice(0, 3 * 1024 * 1024),
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

    const provider = video.provider === "twitch" ? "twitch" : "youtube";
    room.video = {
      provider,
      id: String(video.id),
      title: String(video.title || (provider === "twitch" ? "Directo de Twitch" : "Video de YouTube")).slice(0, 120),
      channel: String(video.channel || (provider === "twitch" ? video.id : "YouTube")).slice(0, 80),
      thumbnail: String(video.thumbnail || (provider === "twitch" ? "" : `https://i.ytimg.com/vi/${String(video.id)}/hqdefault.jpg`)).slice(0, 500),
      live: provider === "twitch"
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
    if (!room.users.has(socket.id)) return callback?.({ ok: false, error: "Primero entra a la sala." });

    const provider = video.provider === "twitch" ? "twitch" : "youtube";
    const item = {
      provider,
      id: String(video.id),
      title: String(video.title || (provider === "twitch" ? "Directo de Twitch" : "Video de YouTube")).slice(0, 120),
      channel: String(video.channel || (provider === "twitch" ? video.id : "YouTube")).slice(0, 80),
      thumbnail: String(video.thumbnail || (provider === "twitch" ? "" : `https://i.ytimg.com/vi/${String(video.id)}/hqdefault.jpg`)).slice(0, 500),
      live: provider === "twitch",
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
    if (!authenticatedIdentityId || socketClients.get(socket.id) !== authenticatedIdentityId) return callback?.({ ok: false, error: "Los invitados no pueden usar llamadas privadas." });
    code = String(code || "").trim().toUpperCase(); target = String(target || "");
    const room = rooms.get(code);
    if (!room || !room.users.has(socket.id) || !room.users.has(target) || target === socket.id) return callback?.({ ok:false, error:"Usuario no disponible." });
    io.to(target).emit("private-call-invite", { from: socket.id, name: room.users.get(socket.id)?.name || "Invitado" });
    callback?.({ ok:true });
  });

  socket.on("private-call-response", ({ code, target, accepted }) => {
    if (!authenticatedIdentityId || socketClients.get(socket.id) !== authenticatedIdentityId) return;
    code = String(code || "").trim().toUpperCase(); target = String(target || "");
    const room = rooms.get(code);
    if (!room || !room.users.has(socket.id) || !room.users.has(target)) return;
    io.to(target).emit("private-call-response", { from: socket.id, accepted: Boolean(accepted) });
  });

  socket.on("private-call-signal", ({ code, target, data }) => {
    if (!authenticatedIdentityId || socketClients.get(socket.id) !== authenticatedIdentityId) return;
    code = String(code || "").trim().toUpperCase(); target = String(target || "");
    const room = rooms.get(code);
    if (!room || !room.users.has(socket.id) || !room.users.has(target)) return;
    io.to(target).emit("private-call-signal", { from: socket.id, data });
  });

  socket.on("private-call-end", ({ code, target }) => {
    if (!authenticatedIdentityId || socketClients.get(socket.id) !== authenticatedIdentityId) return;
    code = String(code || "").trim().toUpperCase(); target = String(target || "");
    const room = rooms.get(code);
    if (!room || !room.users.has(socket.id) || !room.users.has(target)) return;
    io.to(target).emit("private-call-end", { from: socket.id });
  });

  socket.on("private-chat-history", ({ code, target }, callback) => {
    if (!authenticatedIdentityId || socketClients.get(socket.id) !== authenticatedIdentityId) return callback?.({ ok: false, error: "Los invitados no pueden abrir chats privados." });
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
    if (!authenticatedIdentityId || socketClients.get(socket.id) !== authenticatedIdentityId) return callback?.({ ok: false, error: "Los invitados no pueden enviar mensajes privados." });
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

  socket.on("disconnect", () => {
    const disconnectedClientId = socketClients.get(socket.id);
    if (disconnectedClientId && connectedClients.get(disconnectedClientId)?.socketId === socket.id) connectedClients.delete(disconnectedClientId);
    socketClients.delete(socket.id);
    removeFromRooms(socket);
  });
});

async function startServer() {
  try {
    await db.connectMongo();
  } catch (error) {
    console.error("No se pudo conectar con MongoDB Atlas:", error.message);
    console.warn("THESO continuará en modo temporal hasta corregir MONGODB_URI.");
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`THESO iniciado en http://localhost:${PORT}`);
    console.log(db.isMongoReady() ? "✅ MongoDB Atlas conectado." : "⚠️ MongoDB no conectado: chats temporales.");
    console.log(process.env.YOUTUBE_API_KEY ? "✅ YouTube API Key cargada correctamente." : "❌ No se encontró YOUTUBE_API_KEY.");
  });
}

startServer();