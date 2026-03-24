// ─── Base URL ─────────────────────────────────────────────────────────────────
// In dev, Vite proxies /api → FastAPI (localhost:8000).
// In production (Railway), the frontend is served by the same FastAPI process
// so relative URLs work without a base.

const API_BASE = import.meta.env.VITE_API_URL ?? "";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getToken(): string | null {
  return localStorage.getItem("openclaw_token");
}

// ─── Error type ───────────────────────────────────────────────────────────────

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

// ─── Core fetch wrapper ───────────────────────────────────────────────────────

export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getToken();

  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers ?? {}),
  };

  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;

  const res = await fetch(url, { ...options, headers });

  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text().catch(() => null);
    }
    const message =
      typeof body === "object" &&
      body !== null &&
      "detail" in body &&
      typeof (body as Record<string, unknown>).detail === "string"
        ? (body as Record<string, string>).detail
        : `HTTP ${res.status} ${res.statusText}`;
    throw new ApiError(res.status, message, body);
  }

  // 204 No Content
  if (res.status === 204) return undefined as T;

  return res.json() as Promise<T>;
}

// ─── Convenience verbs ────────────────────────────────────────────────────────

export const apiGet = <T = unknown>(path: string) =>
  apiFetch<T>(path, { method: "GET" });

export const apiPost = <T = unknown>(path: string, body: unknown) =>
  apiFetch<T>(path, { method: "POST", body: JSON.stringify(body) });

export const apiPut = <T = unknown>(path: string, body: unknown) =>
  apiFetch<T>(path, { method: "PUT", body: JSON.stringify(body) });

export const apiDelete = <T = unknown>(path: string) =>
  apiFetch<T>(path, { method: "DELETE" });

// ─── OpenClaw-specific API calls ──────────────────────────────────────────────

// ── Text chat ─────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
}

export interface ChatRequest {
  message: string;
  /** Optionally pass previous turns for context */
  history?: ChatMessage[];
}

export interface ChatResponse {
  response: string;
  /** Updated conversation history returned by the backend */
  history?: ChatMessage[];
}

export async function sendChatMessage(
  message: string,
  history: ChatMessage[] = [],
): Promise<ChatResponse> {
  return apiPost<ChatResponse>("/api/openclaw/chat", { message, history });
}

// ── Memory: conversations ─────────────────────────────────────────────────────

export interface ConversationSummary {
  id?: string;
  date?: string;
  summary: string;
  /** Raw markdown block if the backend returns the full file */
  raw?: string;
}

export interface ConversationsResponse {
  conversations: ConversationSummary[];
  /** Raw markdown of the full conversations.md file */
  raw?: string;
}

export async function fetchConversations(): Promise<ConversationsResponse> {
  return apiGet<ConversationsResponse>("/api/memory/conversations");
}

// ── Memory: profile & tasks (bonus – useful for other pages) ─────────────────

export interface ProfileResponse {
  content: string;
}
export const fetchProfile = () =>
  apiGet<ProfileResponse>("/api/memory/profile");

export interface TasksResponse {
  content: string;
}
export const fetchTasks = () => apiGet<TasksResponse>("/api/memory/tasks");

// ── LiveKit token ─────────────────────────────────────────────────────────────

export interface LiveKitTokenResponse {
  token: string;
  url: string;
}

export async function fetchLiveKitToken(
  roomName: string,
  participantName: string,
): Promise<LiveKitTokenResponse> {
  return apiPost<LiveKitTokenResponse>("/api/livekit/token", {
    room_name: roomName,
    participant_name: participantName,
  });
}
