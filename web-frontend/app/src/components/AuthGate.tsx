/**
 * AuthGate.tsx  –  Fix 4: Frontend authentication
 *
 * Wraps the entire app. If OPENCLAW_ACCESS_TOKEN is set on the server,
 * users must supply the token before they can reach any API route.
 *
 * The token is stored in sessionStorage (cleared when the tab closes).
 *
 * Usage – in your App.tsx or main.tsx:
 *
 *   import AuthGate from "./components/AuthGate";
 *
 *   <AuthGate>
 *     <YourApp />
 *   </AuthGate>
 */

import { useState, useEffect, createContext, useContext } from "react";
import type { ReactNode } from "react";

// ── Auth context ──────────────────────────────────────────────────────────────
interface AuthContextValue {
  token: string;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue>({ token: "", logout: () => {} });

/** Hook – use inside any component that needs to make authenticated requests. */
export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

/**
 * Drop-in authenticated fetch.
 * Automatically adds  Authorization: Bearer <token>  to every request.
 *
 * Usage:
 *   const { authFetch } = useAuthFetch();
 *   const data = await authFetch("/api/tasks").then(r => r.json());
 */
export function useAuthFetch() {
  const { token } = useAuth();

  const authFetch = (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers ?? {});
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    return fetch(input, { ...init, headers });
  };

  return { authFetch };
}

// ── Storage key ───────────────────────────────────────────────────────────────
const STORAGE_KEY = "openclaw_access_token";

// ── Component ─────────────────────────────────────────────────────────────────
interface AuthGateProps {
  children: ReactNode;
}

export default function AuthGate({ children }: AuthGateProps) {
  const [token, setToken]     = useState<string>(() => sessionStorage.getItem(STORAGE_KEY) ?? "");
  const [input, setInput]     = useState("");
  const [error, setError]     = useState("");
  const [loading, setLoading] = useState(false);
  // If server has no auth, skip the gate entirely (check with a probe)
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);

  // On mount, probe /api/token with no auth to find out if auth is enabled
  useEffect(() => {
    if (token) {
      // We already have a token — assume auth may be required; validate below
      setAuthRequired(true);
      return;
    }
    fetch("/api/tasks", { method: "GET" })
      .then((r) => {
        setAuthRequired(r.status === 401);
      })
      .catch(() => setAuthRequired(true));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    setLoading(true);
    setError("");

    // Validate the token against a lightweight endpoint
    const res = await fetch("/api/tasks", {
      headers: { Authorization: `Bearer ${input.trim()}` },
    });

    if (res.ok || res.status !== 401) {
      sessionStorage.setItem(STORAGE_KEY, input.trim());
      setToken(input.trim());
    } else {
      setError("Incorrect password. Try again.");
    }
    setLoading(false);
  };

  const logout = () => {
    sessionStorage.removeItem(STORAGE_KEY);
    setToken("");
    setInput("");
  };

  // Still probing
  if (authRequired === null) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-950">
        <div className="text-gray-400 text-sm">Loading…</div>
      </div>
    );
  }

  // Auth not required or already authenticated
  if (!authRequired || token) {
    return (
      <AuthContext.Provider value={{ token, logout }}>
        {children}
      </AuthContext.Provider>
    );
  }

  // ── Login screen ─────────────────────────────────────────────────────────
  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-950">
      <div className="w-full max-w-sm bg-gray-900 border border-gray-800 rounded-2xl p-8 shadow-xl">
        {/* Logo / title */}
        <div className="mb-8 text-center">
          <div className="text-3xl font-bold tracking-tight text-white">
            Open<span className="text-orange-400">Claw</span>
          </div>
          <p className="mt-2 text-sm text-gray-400">Enter your access token to continue</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="token" className="block text-xs font-medium text-gray-400 mb-1.5">
              Access token
            </label>
            <input
              id="token"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="••••••••••••"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5
                         text-white placeholder-gray-600 text-sm
                         focus:outline-none focus:ring-2 focus:ring-orange-400 focus:border-transparent
                         transition"
            />
          </div>

          {error && (
            <p className="text-xs text-red-400 mt-1">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="w-full bg-orange-500 hover:bg-orange-400 disabled:opacity-40
                       text-white font-medium text-sm py-2.5 rounded-lg transition"
          >
            {loading ? "Checking…" : "Enter"}
          </button>
        </form>
      </div>
    </div>
  );
}
