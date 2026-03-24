/**
 * api.ts  –  Fix 4: Authenticated API helper
 *
 * Every component that calls /api/* should use `apiFetch` instead of
 * raw `fetch`.  It reads the token from sessionStorage and injects the
 * Authorization header automatically.
 *
 * Usage:
 *   import { apiFetch } from "../utils/api";
 *
 *   // GET
 *   const tasks = await apiFetch("/api/tasks").then(r => r.json());
 *
 *   // POST
 *   const result = await apiFetch("/api/openclaw/chat", {
 *     method: "POST",
 *     body: JSON.stringify({ messages }),
 *   }).then(r => r.json());
 */

const STORAGE_KEY = "openclaw_access_token";

function getToken(): string {
  return sessionStorage.getItem(STORAGE_KEY) ?? "";
}

/**
 * Authenticated fetch wrapper.
 * Behaves exactly like `fetch` but automatically adds the Bearer token header.
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init.headers ?? {});

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  // Always send JSON content-type for POST/PATCH/PUT if body is a string
  if (
    init.body &&
    typeof init.body === "string" &&
    !headers.has("Content-Type")
  ) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(input, { ...init, headers });
}

// ── Typed convenience wrappers ────────────────────────────────────────────────

export async function apiGet<T = unknown>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export async function apiPost<T = unknown>(
  path: string,
  body: unknown
): Promise<T> {
  const res = await apiFetch(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function apiPatch<T = unknown>(
  path: string,
  body: unknown
): Promise<T> {
  const res = await apiFetch(path, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export async function apiDelete(path: string): Promise<void> {
  const res = await apiFetch(path, { method: "DELETE" });
  if (!res.ok) throw new Error(`DELETE ${path} → ${res.status}`);
}
