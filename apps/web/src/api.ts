const API_URL = (import.meta.env.VITE_API_URL ?? "http://localhost:10000/api").replace(/\/$/, "");
let accessToken: string | null = null;
let refreshPromise: Promise<string | null> | null = null;

export type User = { id: string; email: string; displayName: string };
export type Room = { id: string; name: string; ownerId?: string; createdAt?: string };
export type RunOutput = { id?: string; status: string; verdict: string; stdout: string; stderr: string; exitCode: number | null; error: string | null; wallTimeSeconds?: number };

export function setAccessToken(token: string | null) { accessToken = token; }
export function getAccessToken() { return accessToken; }

async function refreshAccessToken(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = fetch(`${API_URL}/auth/refresh`, { method: "POST", credentials: "include" })
      .then(async (response) => {
        if (!response.ok) return null;
        const result = await response.json();
        accessToken = result.accessToken;
        return accessToken;
      }).catch(() => null).finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

export async function api<T>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  const response = await fetch(`${API_URL}${path}`, { ...options, headers, credentials: "include" });
  if (response.status === 401 && retry && !path.startsWith("/auth/")) {
    const token = await refreshAccessToken();
    if (token) return api<T>(path, options, false);
  }
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? "Request failed");
  return body as T;
}

export async function establishSession(path: "/auth/login" | "/auth/register", body: unknown) {
  const result = await api<{ accessToken: string; user: User }>(path, { method: "POST", body: JSON.stringify(body) }, false);
  accessToken = result.accessToken;
  return result;
}

export async function restoreSession() {
  const token = await refreshAccessToken();
  return token;
}

export const apiUrl = API_URL;
export const wsUrl = import.meta.env.VITE_WS_URL ?? "ws://localhost:10000/collab";
