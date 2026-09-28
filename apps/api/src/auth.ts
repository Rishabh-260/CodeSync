import { createHash, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import argon2 from "argon2";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Request, Response, NextFunction } from "express";
import { db } from "./db/index.js";
import { refreshSessions, users } from "./db/schema.js";

const accessSecret = process.env.JWT_ACCESS_SECRET;
if (!accessSecret || accessSecret.length < 32) throw new Error("JWT_ACCESS_SECRET must be at least 32 characters");
const refreshCookie = "codesync_refresh";
const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: (process.env.NODE_ENV === "production" ? "none" : "lax") as "none" | "lax",
  path: "/api/auth",
  ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
};

export type AuthUser = { id: string; email: string; displayName: string };
export type AuthedRequest = Request & { user: AuthUser };

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

export function signAccessToken(user: AuthUser) {
  return jwt.sign({ email: user.email, name: user.displayName }, accessSecret!, {
    subject: user.id, expiresIn: "15m", issuer: "codesync",
  });
}

export function verifyAccessToken(token: string): AuthUser {
  const payload = jwt.verify(token, accessSecret!, { issuer: "codesync" });
  if (typeof payload === "string" || !payload.sub || typeof payload.email !== "string") throw new Error("Invalid token");
  return { id: payload.sub, email: payload.email, displayName: typeof payload.name === "string" ? payload.name : payload.email };
}

export async function issueSession(user: AuthUser, response: Response) {
  const raw = randomBytes(48).toString("base64url");
  await db.insert(refreshSessions).values({
    userId: user.id,
    tokenHash: sha(raw),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });
  response.cookie(refreshCookie, raw, { ...cookieOptions, maxAge: 30 * 24 * 60 * 60 * 1000 });
  return { accessToken: signAccessToken(user), user };
}

export async function rotateSession(raw: string | undefined, response: Response) {
  if (!raw) throw new Error("Refresh session missing");
  const [session] = await db.select().from(refreshSessions).where(and(
    eq(refreshSessions.tokenHash, sha(raw)), isNull(refreshSessions.revokedAt), gt(refreshSessions.expiresAt, new Date()),
  )).limit(1);
  if (!session) throw new Error("Refresh session expired");
  const [user] = await db.select().from(users).where(eq(users.id, session.userId)).limit(1);
  if (!user) throw new Error("Account unavailable");
  await db.update(refreshSessions).set({ revokedAt: new Date() }).where(eq(refreshSessions.id, session.id));
  return issueSession({ id: user.id, email: user.email, displayName: user.displayName }, response);
}

export async function revokeSession(raw: string | undefined, response: Response) {
  if (raw) await db.update(refreshSessions).set({ revokedAt: new Date() }).where(eq(refreshSessions.tokenHash, sha(raw)));
  response.clearCookie(refreshCookie, cookieOptions);
}

export async function hashPassword(password: string) {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function requireAuth(request: Request, response: Response, next: NextFunction) {
  try {
    const header = request.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return response.status(401).json({ error: "Authentication required" });
    (request as AuthedRequest).user = verifyAccessToken(token);
    next();
  } catch {
    return response.status(401).json({ error: "Invalid or expired access token" });
  }
}

export async function authenticateCollaboration(token: string, roomId: string) {
  const user = verifyAccessToken(token);
  const { roomMembers } = await import("./db/schema.js");
  const [member] = await db.select({ roomId: roomMembers.roomId }).from(roomMembers).where(and(
    eq(roomMembers.roomId, roomId), eq(roomMembers.userId, user.id),
  )).limit(1);
  if (!member) throw new Error("Room access denied");
  return user;
}

export { refreshCookie };
