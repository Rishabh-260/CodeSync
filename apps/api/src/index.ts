import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { Hocuspocus, type WebSocketLike } from "@hocuspocus/server";
import crossws from "crossws/adapters/node";
import * as Y from "yjs";
import { db, pool } from "./db/index.js";
import { users, rooms, roomMembers, roomInvites, roomDocuments } from "./db/schema.js";
import { authenticateCollaboration, hashPassword, issueSession, requireAuth, revokeSession, rotateSession, verifyAccessToken, type AuthedRequest } from "./auth.js";
import { runCode, RunnerError } from "./runner.js";

const app = express();
const server = createServer(app);
app.set("trust proxy", 1);
const routeParam = (req: express.Request, name: string) => {
  const value = req.params[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
};
const frontendOrigins = (process.env.FRONTEND_ORIGINS ?? "http://localhost:5173").split(",").map((value) => value.trim().replace(/\/$/, "")).filter(Boolean);
app.disable("x-powered-by");
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({ origin: frontendOrigins, credentials: true, methods: ["GET", "POST", "DELETE", "OPTIONS"] }));
app.use(express.json({ limit: "300kb" }));
app.use(cookieParser());

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });
const runTimes = new Map<string, number[]>();
const activeRuns = new Set<string>();
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const memberOf = async (roomId: string, userId: string) => {
  const [member] = await db.select({ roomId: roomMembers.roomId }).from(roomMembers).where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId))).limit(1);
  return Boolean(member);
};
const ownerOf = async (roomId: string, userId: string) => {
  const [room] = await db.select().from(rooms).where(and(eq(rooms.id, roomId), eq(rooms.ownerId, userId))).limit(1);
  return room;
};
const requireAllowedOrigin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const origin = req.header("origin");
  if (!origin || !frontendOrigins.includes(origin.replace(/\/$/, ""))) return res.status(403).json({ error: "Request origin is not allowed" });
  next();
};

app.get("/health", (_req, res) => res.json({ ok: true }));
app.post("/api/auth/register", authLimiter, async (req, res, next) => {
  try {
    const body = z.object({ email: z.string().email().max(320), password: z.string().min(10).max(128), displayName: z.string().trim().min(1).max(80) }).parse(req.body);
    const email = body.email.toLowerCase();
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing) return res.status(409).json({ error: "An account with that email already exists" });
    const [user] = await db.insert(users).values({ email, passwordHash: await hashPassword(body.password), displayName: body.displayName }).returning();
    res.status(201).json(await issueSession({ id: user.id, email: user.email, displayName: user.displayName }, res));
  } catch (error) { next(error); }
});
app.post("/api/auth/login", authLimiter, async (req, res, next) => {
  try {
    const body = z.object({ email: z.string().email(), password: z.string().min(1).max(128) }).parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.email, body.email.toLowerCase())).limit(1);
    if (!user || !(await (await import("argon2")).default.verify(user.passwordHash, body.password))) return res.status(401).json({ error: "Email or password is incorrect" });
    res.json(await issueSession({ id: user.id, email: user.email, displayName: user.displayName }, res));
  } catch (error) { next(error); }
});
app.post("/api/auth/refresh", authLimiter, requireAllowedOrigin, async (req, res, next) => {
  try { res.json(await rotateSession(req.cookies.codesync_refresh, res)); }
  catch { await revokeSession(req.cookies.codesync_refresh, res); res.status(401).json({ error: "Session expired. Sign in again." }); }
});
app.post("/api/auth/logout", requireAllowedOrigin, async (req, res, next) => {
  try { await revokeSession(req.cookies.codesync_refresh, res); res.status(204).end(); }
  catch (error) { next(error); }
});
app.get("/api/auth/me", requireAuth, (req, res) => res.json({ user: (req as AuthedRequest).user }));

app.get("/api/rooms", requireAuth, async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user;
    const result = await db.select({ id: rooms.id, name: rooms.name, ownerId: rooms.ownerId, createdAt: rooms.createdAt })
      .from(roomMembers).innerJoin(rooms, eq(roomMembers.roomId, rooms.id)).where(eq(roomMembers.userId, user.id)).orderBy(desc(rooms.createdAt));
    res.json({ rooms: result });
  } catch (error) { next(error); }
});
app.post("/api/rooms", requireAuth, async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user;
    const { name } = z.object({ name: z.string().trim().min(1).max(120) }).parse(req.body);
    const [room] = await db.insert(rooms).values({ name, ownerId: user.id }).returning();
    await db.insert(roomMembers).values({ roomId: room.id, userId: user.id });
    const doc = new Y.Doc();
    doc.getMap("meta").set("language", "javascript");
    doc.getText("code");
    await db.insert(roomDocuments).values({ roomId: room.id, state: Buffer.from(Y.encodeStateAsUpdate(doc)) });
    const token = randomBytes(32).toString("base64url");
    await db.insert(roomInvites).values({ roomId: room.id, tokenHash: sha(token) });
    res.status(201).json({ room, inviteToken: token });
  } catch (error) { next(error); }
});
app.get("/api/rooms/:roomId", requireAuth, async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user;
    const roomId = routeParam(req, "roomId");
    if (!(await memberOf(roomId, user.id))) return res.status(404).json({ error: "Room not found" });
    const [room] = await db.select({ id: rooms.id, name: rooms.name, ownerId: rooms.ownerId, createdAt: rooms.createdAt }).from(rooms).where(eq(rooms.id, roomId)).limit(1);
    res.json({ room, isOwner: room.ownerId === user.id });
  } catch (error) { next(error); }
});
app.delete("/api/rooms/:roomId", requireAuth, async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user;
    const roomId = routeParam(req, "roomId");
    if (!(await ownerOf(roomId, user.id))) return res.status(404).json({ error: "Room not found" });
    collaboration.closeConnections(`room:${roomId}`);
    await db.delete(rooms).where(eq(rooms.id, roomId));
    res.status(204).end();
  } catch (error) { next(error); }
});
app.post("/api/rooms/:roomId/invites", requireAuth, async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user;
    const roomId = routeParam(req, "roomId");
    if (!(await ownerOf(roomId, user.id))) return res.status(404).json({ error: "Room not found" });
    await db.update(roomInvites).set({ revokedAt: new Date() }).where(and(eq(roomInvites.roomId, roomId), isNull(roomInvites.revokedAt)));
    const token = randomBytes(32).toString("base64url");
    await db.insert(roomInvites).values({ roomId, tokenHash: sha(token) });
    res.status(201).json({ inviteToken: token });
  } catch (error) { next(error); }
});
app.delete("/api/rooms/:roomId/invites", requireAuth, async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user;
    const roomId = routeParam(req, "roomId");
    if (!(await ownerOf(roomId, user.id))) return res.status(404).json({ error: "Room not found" });
    await db.update(roomInvites).set({ revokedAt: new Date() }).where(and(eq(roomInvites.roomId, roomId), isNull(roomInvites.revokedAt)));
    res.status(204).end();
  } catch (error) { next(error); }
});
app.post("/api/invites/:token/accept", requireAuth, async (req, res, next) => {
  try {
    const user = (req as AuthedRequest).user;
    const token = routeParam(req, "token");
    const [invite] = await db.select().from(roomInvites).where(and(eq(roomInvites.tokenHash, sha(token)), isNull(roomInvites.revokedAt))).limit(1);
    if (!invite) return res.status(404).json({ error: "Invite is invalid or has been revoked" });
    await db.insert(roomMembers).values({ roomId: invite.roomId, userId: user.id }).onConflictDoNothing();
    const [room] = await db.select({ id: rooms.id, name: rooms.name }).from(rooms).where(eq(rooms.id, invite.roomId)).limit(1);
    if (!room) return res.status(404).json({ error: "Room no longer exists" });
    res.json({ room });
  } catch (error) { next(error); }
});

app.post("/api/rooms/:roomId/runs", requireAuth, async (req, res, next) => {
  const user = (req as AuthedRequest).user;
  try {
    const roomId = routeParam(req, "roomId");
    if (!(await memberOf(roomId, user.id))) return res.status(404).json({ error: "Room not found" });
    const body = z.object({ language: z.enum(["javascript", "python"]), code: z.string().max(70_000), stdin: z.string().max(280_000).optional() }).parse(req.body);
    const now = Date.now();
    const previous = (runTimes.get(user.id) ?? []).filter((time) => now - time < 60_000);
    if (previous.length >= 5) return res.status(429).json({ error: "Run limit reached. Try again in a minute." });
    if (activeRuns.has(user.id)) return res.status(429).json({ error: "You already have a run in progress" });
    runTimes.set(user.id, [...previous, now]);
    activeRuns.add(user.id);
    const result = await runCode(body);
    res.json(result);
  } catch (error) {
    if (error instanceof RunnerError) return res.status(error.status).json({ error: error.message, code: error.code });
    next(error);
  } finally { activeRuns.delete(user.id); }
});

const collaboration = new Hocuspocus({
  debounce: 1200,
  maxDebounce: 5000,
  async onAuthenticate({ documentName, token }) {
    const match = /^room:([0-9a-f-]{36})$/i.exec(documentName);
    if (!match) throw new Error("Invalid room document");
    return authenticateCollaboration(token, match[1]);
  },
  async onLoadDocument({ documentName }) {
    const roomId = documentName.slice("room:".length);
    const [saved] = await db.select().from(roomDocuments).where(eq(roomDocuments.roomId, roomId)).limit(1);
    const doc = new Y.Doc();
    if (saved) Y.applyUpdate(doc, new Uint8Array(saved.state));
    else {
      doc.getMap("meta").set("language", "javascript");
      doc.getText("code");
    }
    return doc;
  },
  async onStoreDocument({ documentName, document }) {
    const roomId = documentName.slice("room:".length);
    await db.insert(roomDocuments).values({ roomId, state: Buffer.from(Y.encodeStateAsUpdate(document)), updatedAt: new Date() })
      .onConflictDoUpdate({ target: roomDocuments.roomId, set: { state: Buffer.from(Y.encodeStateAsUpdate(document)), updatedAt: new Date() } });
  },
});

const ws = crossws({
  hooks: {
    open(peer) {
      const connection = collaboration.handleConnection(peer.websocket as unknown as WebSocketLike, peer.request as unknown as globalThis.Request);
      (peer as any)._hocuspocus = connection;
    },
    message(peer, message) { (peer as any)._hocuspocus?.handleMessage(message.uint8Array()); },
    close(peer, event) { (peer as any)._hocuspocus?.handleClose({ code: event.code, reason: event.reason }); },
    error(peer, error) { console.error("Collaboration socket error", error); },
  },
});
server.on("upgrade", (request, socket, head) => {
  if (request.url?.startsWith("/collab")) ws.handleUpgrade(request, socket, head);
  else socket.destroy();
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof z.ZodError) return res.status(400).json({ error: "Invalid request", details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) });
  console.error(error);
  res.status(500).json({ error: "Internal server error" });
});

const port = Number(process.env.PORT ?? 10000);
server.listen(port, "0.0.0.0", () => console.log(`CodeSync API listening on ${port}`));
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    collaboration.closeConnections();
    await new Promise((resolve) => setTimeout(resolve, 5500));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
    process.exit(0);
  });
}
