/**
 * function-bun  –  Fix 6: Tool execution service for OpenClaw
 *
 * This is a lightweight Bun HTTP server that gives OpenClaw access to
 * real-world tools (web search, URL fetching, current time, etc.)
 *
 * Deploy on Railway as a separate service from the same repo.
 * Set the root directory to  function-bun/  and the start command to:
 *   bun run index.ts
 *
 * Environment variables needed:
 *   PORT                    – set automatically by Railway
 *   OPENCLAW_ACCESS_TOKEN   – same token used by main.py (auth guard)
 *
 * Integration with voice-agent/agent.py:
 *   Set FUNCTION_BUN_URL=https://<your-service>.up.railway.app in Railway.
 *   The agent can then call these endpoints via httpx.
 *
 * Available tools:
 *   GET  /health                  health check
 *   GET  /tools                   list available tools
 *   POST /tools/web_search        { "query": "..." }
 *   POST /tools/fetch_url         { "url": "https://..." }
 *   GET  /tools/get_time          returns UTC + human-readable time
 *   POST /tools/calculate         { "expression": "2 + 2 * 10" }
 */

const PORT         = Number(process.env.PORT ?? 3001);
const ACCESS_TOKEN = process.env.OPENCLAW_ACCESS_TOKEN ?? "";

// ── Auth ──────────────────────────────────────────────────────────────────────
function isAuthorized(req: Request): boolean {
  if (!ACCESS_TOKEN) return true; // auth disabled
  const header = req.headers.get("Authorization") ?? "";
  if (header.startsWith("Bearer ")) {
    return header.slice(7) === ACCESS_TOKEN;
  }
  return false;
}

function unauthorized(): Response {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

// ── Tool implementations ───────────────────────────────────────────────────────

/** DuckDuckGo Instant Answer API – no key required, good for quick facts */
async function webSearch(query: string): Promise<string> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  try {
    const res  = await fetch(url, { headers: { "User-Agent": "OpenClaw/1.0" } });
    const data = await res.json() as Record<string, unknown>;

    const abstract = (data.AbstractText as string) || "";
    const answer   = (data.Answer as string) || "";
    const related  = ((data.RelatedTopics as unknown[]) ?? [])
      .slice(0, 3)
      .map((t: unknown) => (t as Record<string,string>).Text ?? "")
      .filter(Boolean)
      .join("\n");

    return abstract || answer || related || "No results found for that query.";
  } catch (err) {
    return `Search error: ${err}`;
  }
}

/** Fetch a URL and strip HTML to plain text (truncated to 3 000 chars) */
async function fetchUrl(targetUrl: string): Promise<string> {
  try {
    const res  = await fetch(targetUrl, {
      headers: { "User-Agent": "OpenClaw/1.0" },
      // Abort if > 5 s
      signal: AbortSignal.timeout(5_000),
    });
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 3_000);
    return text || "(page was empty)";
  } catch (err) {
    return `Fetch error: ${err}`;
  }
}

/** Safe arithmetic evaluator – no eval(), only basic math */
function calculate(expression: string): string {
  // Allow only digits, operators, spaces, dots, and parentheses
  if (!/^[\d\s+\-*/().%^]+$/.test(expression)) {
    return "Invalid expression. Only basic arithmetic is supported.";
  }
  try {
    // Use Function constructor as a sandboxed alternative to eval
    // eslint-disable-next-line no-new-func
    const result = new Function(`"use strict"; return (${expression})`)();
    return String(result);
  } catch {
    return "Could not evaluate that expression.";
  }
}

// ── Tool catalogue (for /tools endpoint) ─────────────────────────────────────
const TOOLS = [
  {
    name:        "web_search",
    description: "Search the web using DuckDuckGo. Returns an abstract or top results.",
    method:      "POST",
    path:        "/tools/web_search",
    body:        { query: "string" },
  },
  {
    name:        "fetch_url",
    description: "Fetch a URL and return plain-text content (max 3 000 chars).",
    method:      "POST",
    path:        "/tools/fetch_url",
    body:        { url: "string" },
  },
  {
    name:        "get_time",
    description: "Return the current UTC time and a human-readable local time.",
    method:      "GET",
    path:        "/tools/get_time",
  },
  {
    name:        "calculate",
    description: "Evaluate a basic arithmetic expression (+ - * / % parentheses).",
    method:      "POST",
    path:        "/tools/calculate",
    body:        { expression: "string" },
  },
];

// ── Server ────────────────────────────────────────────────────────────────────
Bun.serve({
  port: PORT,

  async fetch(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);

    // ── Health (no auth needed) ────────────────────────────────────────────
    if (pathname === "/health" && req.method === "GET") {
      return Response.json({ status: "ok", service: "function-bun", ts: new Date().toISOString() });
    }

    // ── Tool catalogue (no auth needed) ────────────────────────────────────
    if (pathname === "/tools" && req.method === "GET") {
      return Response.json({ tools: TOOLS });
    }

    // ── All other routes require auth ──────────────────────────────────────
    if (!isAuthorized(req)) return unauthorized();

    // ── web_search ─────────────────────────────────────────────────────────
    if (pathname === "/tools/web_search" && req.method === "POST") {
      const body  = await req.json() as Record<string, string>;
      const query = body.query ?? body.q ?? "";
      if (!query) return Response.json({ error: "Missing 'query' field" }, { status: 400 });
      const result = await webSearch(query);
      return Response.json({ result });
    }

    // ── fetch_url ──────────────────────────────────────────────────────────
    if (pathname === "/tools/fetch_url" && req.method === "POST") {
      const body = await req.json() as Record<string, string>;
      const url  = body.url ?? "";
      if (!url) return Response.json({ error: "Missing 'url' field" }, { status: 400 });
      const result = await fetchUrl(url);
      return Response.json({ result });
    }

    // ── get_time ───────────────────────────────────────────────────────────
    if (pathname === "/tools/get_time" && req.method === "GET") {
      const now = new Date();
      return Response.json({
        utc:   now.toISOString(),
        human: now.toUTCString(),
        epoch: now.getTime(),
      });
    }

    // ── calculate ──────────────────────────────────────────────────────────
    if (pathname === "/tools/calculate" && req.method === "POST") {
      const body       = await req.json() as Record<string, string>;
      const expression = body.expression ?? "";
      if (!expression) return Response.json({ error: "Missing 'expression' field" }, { status: 400 });
      const result = calculate(expression);
      return Response.json({ expression, result });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log(`✅  function-bun listening on port ${PORT}`);
