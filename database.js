const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  identityId: { type: String, required: true, unique: true, index: true },
  discordId: { type: String, default: "", index: true },
  username: { type: String, default: "" },
  name: { type: String, required: true, maxlength: 30 },
  avatar: { type: String, default: "" },
  banner: { type: String, default: "" },
  lastSeenAt: { type: Date, default: Date.now }
}, { timestamps: true });

const friendshipSchema = new mongoose.Schema({
  pairKey: { type: String, required: true, unique: true, index: true },
  users: { type: [String], required: true, index: true }
}, { timestamps: true });

const friendRequestSchema = new mongoose.Schema({
  senderId: { type: String, required: true, index: true },
  receiverId: { type: String, required: true, index: true },
  status: { type: String, enum: ["pending", "accepted", "rejected", "cancelled"], default: "pending", index: true }
}, { timestamps: true });
friendRequestSchema.index({ senderId: 1, receiverId: 1, status: 1 });

const conversationSchema = new mongoose.Schema({
  pairKey: { type: String, required: true, unique: true, index: true },
  members: { type: [String], required: true, index: true },
  lastMessageAt: { type: Date, default: Date.now, index: true }
}, { timestamps: true });

const messageSchema = new mongoose.Schema({
  conversationId: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation", required: true, index: true },
  senderId: { type: String, required: true, index: true },
  receiverId: { type: String, required: true, index: true },
  text: { type: String, default: "", maxlength: 400 },
  image: { type: mongoose.Schema.Types.Mixed, default: null },
  messageType: { type: String, enum: ["text", "room_invite"], default: "text" },
  invite: { type: mongoose.Schema.Types.Mixed, default: null },
  replyTo: { type: mongoose.Schema.Types.ObjectId, ref: "Message", default: null },
  reactions: { type: mongoose.Schema.Types.Mixed, default: {} },
  editedAt: { type: Date, default: null },
  deletedAt: { type: Date, default: null },
  readAt: { type: Date, default: null }
}, { timestamps: true });
messageSchema.index({ conversationId: 1, createdAt: -1 });

const User = mongoose.models.User || mongoose.model("User", userSchema);
const Friendship = mongoose.models.Friendship || mongoose.model("Friendship", friendshipSchema);
const FriendRequest = mongoose.models.FriendRequest || mongoose.model("FriendRequest", friendRequestSchema);
const Conversation = mongoose.models.Conversation || mongoose.model("Conversation", conversationSchema);
const Message = mongoose.models.Message || mongoose.model("Message", messageSchema);

function safeIdentity(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100);
}

function pairKey(a, b) {
  return [safeIdentity(a), safeIdentity(b)].sort().join(":");
}

let connected = false;

async function connectMongo() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("MONGODB_URI no está configurado. THESO usará chats temporales en memoria.");
    return false;
  }
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10000,
    maxPoolSize: 10
  });
  connected = true;
  console.log("MongoDB Atlas conectado.");
  return true;
}

function isMongoReady() {
  return connected && mongoose.connection.readyState === 1;
}

async function upsertDiscordUser(identityId, discordUser, profile = {}) {
  if (!isMongoReady()) return null;
  return User.findOneAndUpdate(
    { identityId },
    {
      $set: {
        discordId: String(discordUser.id || ""),
        username: String(discordUser.username || "").slice(0, 80),
        name: String(profile.name || discordUser.displayName || discordUser.username || "Usuario").slice(0, 30),
        avatar: String(profile.avatar || discordUser.avatar || "").slice(0, 3 * 1024 * 1024),
        banner: String(profile.banner || "").slice(0, 3 * 1024 * 1024),
        lastSeenAt: new Date()
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
}

async function updateUserProfile(identityId, profile = {}) {
  if (!isMongoReady()) return null;
  return User.findOneAndUpdate(
    { identityId },
    { $set: {
      name: String(profile.name || "Usuario").slice(0, 30),
      avatar: String(profile.avatar || "").slice(0, 3 * 1024 * 1024),
      banner: String(profile.banner || "").slice(0, 3 * 1024 * 1024),
      lastSeenAt: new Date()
    } },
    { new: true }
  ).lean();
}

async function areFriends(a, b) {
  if (!isMongoReady()) return true;
  return Boolean(await Friendship.exists({ pairKey: pairKey(a, b) }));
}

async function sendFriendRequest(senderId, receiverId) {
  if (!isMongoReady()) throw new Error("MongoDB no está conectado.");
  senderId = safeIdentity(senderId);
  receiverId = safeIdentity(receiverId);
  if (!senderId || !receiverId || senderId === receiverId) throw new Error("Solicitud no válida.");
  if (await areFriends(senderId, receiverId)) throw new Error("Ya son amigos.");
  const reverse = await FriendRequest.findOne({ senderId: receiverId, receiverId: senderId, status: "pending" });
  if (reverse) return { reverseRequest: reverse.toObject() };
  const existing = await FriendRequest.findOne({ senderId, receiverId, status: "pending" });
  if (existing) throw new Error("La solicitud ya fue enviada.");
  const request = await FriendRequest.create({ senderId, receiverId });
  return { request: request.toObject() };
}

async function respondFriendRequest(requestId, receiverId, accept) {
  if (!isMongoReady()) throw new Error("MongoDB no está conectado.");
  const request = await FriendRequest.findOne({ _id: requestId, receiverId: safeIdentity(receiverId), status: "pending" });
  if (!request) throw new Error("La solicitud ya no está disponible.");
  request.status = accept ? "accepted" : "rejected";
  await request.save();
  if (accept) {
    await Friendship.updateOne(
      { pairKey: pairKey(request.senderId, request.receiverId) },
      { $setOnInsert: { users: [request.senderId, request.receiverId] } },
      { upsert: true }
    );
  }
  return request.toObject();
}

async function getFriendState(identityId) {
  if (!isMongoReady()) return { friends: [], incoming: [], outgoing: [] };
  identityId = safeIdentity(identityId);
  const [friendships, incoming, outgoing] = await Promise.all([
    Friendship.find({ users: identityId }).lean(),
    FriendRequest.find({ receiverId: identityId, status: "pending" }).sort({ createdAt: -1 }).lean(),
    FriendRequest.find({ senderId: identityId, status: "pending" }).sort({ createdAt: -1 }).lean()
  ]);
  const friendIds = friendships.flatMap(item => item.users).filter(id => id !== identityId);
  const allIds = [...new Set([...friendIds, ...incoming.map(r => r.senderId), ...outgoing.map(r => r.receiverId)])];
  const users = await User.find({ identityId: { $in: allIds } }).lean();
  const byId = new Map(users.map(user => [user.identityId, user]));
  const meta = id => {
    const user = byId.get(id) || {};
    return { clientId: id, name: user.name || "Usuario", avatar: user.avatar || "", banner: user.banner || "" };
  };
  return {
    friends: friendIds.map(meta),
    incoming: incoming.map(request => ({ requestId: String(request._id), ...meta(request.senderId), createdAt: request.createdAt })),
    outgoing: outgoing.map(request => ({ requestId: String(request._id), ...meta(request.receiverId), createdAt: request.createdAt }))
  };
}

async function getConversationContacts(identityId) {
  if (!isMongoReady()) return [];
  const conversations = await Conversation.find({ members: identityId }).sort({ lastMessageAt: -1 }).lean();
  const ids = conversations.flatMap(c => c.members).filter(id => id !== identityId);
  const users = await User.find({ identityId: { $in: [...new Set(ids)] } }).lean();
  return users.map(user => ({ clientId: user.identityId, name: user.name, avatar: user.avatar || "", banner: user.banner || "" }));
}

function serializeMessage(message, reply = null) {
  return {
    id: String(message._id),
    fromClientId: message.senderId,
    toClientId: message.receiverId,
    author: "",
    text: message.deletedAt ? "" : (message.text || ""),
    image: message.deletedAt ? null : (message.image || null),
    messageType: message.messageType || "text",
    invite: message.deletedAt ? null : (message.invite || null),
    replyTo: reply ? { id: String(reply._id), fromClientId: reply.senderId, text: reply.deletedAt ? "Mensaje eliminado" : (reply.text || (reply.image ? "Imagen" : "Mensaje")) } : null,
    reactions: message.reactions || {},
    editedAt: message.editedAt ? new Date(message.editedAt).getTime() : null,
    deletedAt: message.deletedAt ? new Date(message.deletedAt).getTime() : null,
    readAt: message.readAt ? new Date(message.readAt).getTime() : null,
    createdAt: new Date(message.createdAt).getTime()
  };
}

async function getMessages(a, b, limit = 150) {
  if (!isMongoReady()) return [];
  const conversation = await Conversation.findOne({ pairKey: pairKey(a, b) }).lean();
  if (!conversation) return [];
  const messages = await Message.find({ conversationId: conversation._id }).sort({ createdAt: -1 }).limit(limit).lean();
  const ordered = messages.reverse();
  const replyIds = ordered.map(m => m.replyTo).filter(Boolean);
  const replies = replyIds.length ? await Message.find({ _id: { $in: replyIds } }).lean() : [];
  const replyMap = new Map(replies.map(r => [String(r._id), r]));
  return ordered.map(message => serializeMessage(message, message.replyTo ? replyMap.get(String(message.replyTo)) : null));
}

async function saveMessage(senderId, receiverId, text, image, author, replyToId = null) {
  if (!isMongoReady()) return null;
  const key = pairKey(senderId, receiverId);
  const conversation = await Conversation.findOneAndUpdate(
    { pairKey: key },
    { $set: { lastMessageAt: new Date() }, $setOnInsert: { members: [senderId, receiverId] } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  let reply = null;
  if (replyToId && mongoose.isValidObjectId(replyToId)) {
    reply = await Message.findOne({ _id: replyToId, conversationId: conversation._id }).lean();
  }
  const saved = await Message.create({ conversationId: conversation._id, senderId, receiverId, text, image, replyTo: reply?._id || null });
  return { ...serializeMessage(saved.toObject(), reply), author };
}

async function saveRoomInvite(senderId, receiverId, author, invite = {}) {
  if (!isMongoReady()) return null;
  const key = pairKey(senderId, receiverId);
  const conversation = await Conversation.findOneAndUpdate(
    { pairKey: key },
    { $set: { lastMessageAt: new Date() }, $setOnInsert: { members: [senderId, receiverId] } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  const safeInvite = {
    code: String(invite.code || "").trim().toUpperCase().slice(0, 12),
    roomName: String(invite.roomName || "Sala").slice(0, 60),
    visibility: invite.visibility === "private" ? "private" : "public"
  };
  const text = `${author || "Un amigo"} te invitó a “${safeInvite.roomName}”`;
  const saved = await Message.create({ conversationId: conversation._id, senderId, receiverId, text, messageType: "room_invite", invite: safeInvite });
  return { ...serializeMessage(saved.toObject()), author };
}

async function editMessage(identityId, messageId, text) {
  if (!isMongoReady() || !mongoose.isValidObjectId(messageId)) throw new Error("Mensaje no válido.");
  text = String(text || "").trim().slice(0, 400);
  if (!text) throw new Error("El mensaje no puede quedar vacío.");
  const message = await Message.findOneAndUpdate(
    { _id: messageId, senderId: safeIdentity(identityId), deletedAt: null },
    { $set: { text, editedAt: new Date() } },
    { new: true }
  );
  if (!message) throw new Error("No puedes editar este mensaje.");
  return serializeMessage(message.toObject());
}

async function deleteMessage(identityId, messageId) {
  if (!isMongoReady() || !mongoose.isValidObjectId(messageId)) throw new Error("Mensaje no válido.");
  const message = await Message.findOneAndUpdate(
    { _id: messageId, senderId: safeIdentity(identityId), deletedAt: null },
    { $set: { text: "", image: null, deletedAt: new Date() } },
    { new: true }
  );
  if (!message) throw new Error("No puedes eliminar este mensaje.");
  return serializeMessage(message.toObject());
}

async function toggleReaction(identityId, messageId, emoji) {
  if (!isMongoReady() || !mongoose.isValidObjectId(messageId)) throw new Error("Mensaje no válido.");
  emoji = String(emoji || "").slice(0, 8);
  if (!emoji) throw new Error("Reacción no válida.");
  const message = await Message.findById(messageId);
  if (!message || message.deletedAt) throw new Error("Mensaje no disponible.");
  const reactions = { ...(message.reactions || {}) };
  const users = Array.isArray(reactions[emoji]) ? reactions[emoji].map(String) : [];
  const id = safeIdentity(identityId);
  reactions[emoji] = users.includes(id) ? users.filter(x => x !== id) : [...users, id];
  if (!reactions[emoji].length) delete reactions[emoji];
  message.reactions = reactions;
  message.markModified("reactions");
  await message.save();
  return serializeMessage(message.toObject());
}

async function markConversationRead(readerId, otherId) {
  if (!isMongoReady()) return 0;
  const conversation = await Conversation.findOne({ pairKey: pairKey(readerId, otherId) });
  if (!conversation) return 0;
  const result = await Message.updateMany({ conversationId: conversation._id, receiverId: safeIdentity(readerId), readAt: null }, { $set: { readAt: new Date() } });
  return result.modifiedCount || 0;
}

module.exports = {
  connectMongo,
  isMongoReady,
  pairKey,
  upsertDiscordUser,
  updateUserProfile,
  areFriends,
  sendFriendRequest,
  respondFriendRequest,
  getFriendState,
  getConversationContacts,
  getMessages,
  saveMessage,
  saveRoomInvite,
  editMessage,
  deleteMessage,
  toggleReaction,
  markConversationRead
};
