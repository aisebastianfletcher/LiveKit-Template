/**
 * function-bun - Tool execution + code runner for OpenClaw
 * 
 * Endpoints:
 *   GET  /health          - health check
 *   GET  /tools           - list available tools
 *   POST /                - execute arbitrary JS/TS code (for autonomous agent)
 *   POST /tools/web_search
 *   POST /tools/fetch_url
 *   GET  /tools/get_time
 *   POST /tools/calculate
 *   DELETE /api/tasks/:id - proxy delete to web-frontend API
 */

const PORT = Number(process.env.PORT ?? 3001);
const ACCESS_TOKEN = process.env.OPENCLAW_ACCESS_TOKEN ?? "";
const FUNCTION_BUN_TOKEN = process.env.FUNCTION_BUN_TOKEN ?? "";
const WEB_FRONTEND_URL = (process.env.WEB_FRONTEND_URL ?? "http://localhost:8000").replace(/\/$/, "");

function isAuthorized(req: Request): boolean {
  // Check both tokens
  if (!ACCESS_TOKEN && !FUNCTION_BUN_TOKEN) return true;
  const header = req.headers.get("Authorization") ?? "";
  if (header.startsWith("Bearer ")) {
    const token = header.slice(7);
    return token === ACCESS_TOKEN || token === FUNCTION_BUN_TOKEN;
  }
  return false;
}

function unauthorized(): Response {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

// -- Tool implementations
async function webSearch(query: string): Promise<string> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "OpenClaw/1.0" } });
    const data = await res.json() as Record<string, unknown>;
    const abstract = (data.AbstractText as string) || "";
    const answer = (data.Answer as string) || "";
    const related = ((data.RelatedTopics as unknown[]) ?? [])
      .slice(0, 3)
      .map((t: unknown) => (t as Record<string, string>).Text ?? "")
      .filter(Boolean)
      .join("\n");
    return abstract || answer || related || "No results found.";
  } catch (err) {
    return `Search error: ${err}`;
  }
}

async function fetchUrl(targetUrl: string): Promise<string> {
  try {
    const res = await fetch(targetUrl, {
      headers: { "User-Agent": "OpenClaw/1.0" },
      signal: AbortSignal.timeout(5_000),
    });
    const html = await res.text();
    return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 3_000) || "(empty)";
  } catch (err) {
    return `Fetch error: ${err}`;
  }
}

function calculate(expression: string): string {
  if (!/^[\d\s+\-*/().%^]+$/.test(expression)) {
    return "Invalid expression.";
  }
  try {
    const result = new Function(`"use strict"; return (${expression})`)();
    return String(result);
  } catch {
    return "Could not evaluate.";
  }
}

const TOOLS = [
  { name: "web_search", method: "POST", path: "/tools/web_search", body: { query: "string" } },
  { name: "fetch_url", method: "POST", path: "/tools/fetch_url", body: { url: "string" } },
  { name: "get_time", method: "GET", path: "/tools/get_time" },
  { name: "calculate", method: "POST", path: "/tools/calculate", body: { expression: "string" } },
  { name: "exec", method: "POST", path: "/", body: { code: "string", input: "object", timeout_ms: "number" } },
];

// -- Server
Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);

    if (pathname === "/health" && req.method === "GET") {
      return Response.json({ status: "ok", service: "function-bun", ts: new Date().toISOString() });
    }
    if (pathname === "/tools" && req.method === "GET") {
      return Response.json({ tools: TOOLS });
    }

    if (!isAuthorized(req)) return unauthorized();

    // -- Code execution endpoint (root POST)
    if (pathname === "/" && req.method === "POST") {
      const body = await req.json() as { code?: string; input?: unknown; timeout_ms?: number };
      const code = body.code ?? "";
      const timeout = body.timeout_ms ?? 10_000;
      (globalThis as any).INPUT = body.input ?? null;
      (globalThis as any).RESULTS = [];
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args) => { logs.push(args.map(String).join(" ")); origLog(...args); };
      let result: unknown = null;
      let error: string | null = null;
      try {
        const fn = new Function(`return (async () => { ${code} })()`);
        result = await Promise.race([
          fn(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeout)),
        ]);
      } catch (e) {
        error = String(e);
      } finally {
        console.log = origLog;
      }
      return Response.json({ result, error, logs });
    }

    // -- web_search
    if (pathname === "/tools/web_search" && req.method === "POST") {
      const body = await req.json() as Record<string, string>;
      const query = body.query ?? body.q ?? "";
      if (!query) return Response.json({ error: "Missing 'query'" }, { status: 400 });
      return Response.json({ result: await webSearch(query) });
    }
    // -- fetch_url
    if (pathname === "/tools/fetch_url" && req.method === "POST") {
      const body = await req.json() as Record<string, string>;
      if (!body.url) return Response.json({ error: "Missing 'url'" }, { status: 400 });
      return Response.json({ result: await fetchUrl(body.url) });
    }
    // -- get_time
    if (pathname === "/tools/get_time" && req.method === "GET") {
      const now = new Date();
      return Response.json({ utc: now.toISOString(), human: now.toUTCString(), epoch: now.getTime() });
    }
    // -- calculate
    if (pathname === "/tools/calculate" && req.method === "POST") {
      const body = await req.json() as Record<string, string>;
      if (!body.expression) return Response.json({ error: "Missing 'expression'" }, { status: 400 });
      return Response.json({ expression: body.expression, result: calculate(body.expression) });
    }

    // -- DELETE /api/tasks/:id  (proxy to web-frontend so agents can clean up completed tasks)
    const taskDeleteMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskDeleteMatch && req.method === "DELETE") {
      const taskId = taskDeleteMatch[1];
      try {
        const upstream = await fetch(`${WEB_FRONTEND_URL}/api/tasks/${taskId}`, {
          method: "DELETE",
          headers: { "Authorization": req.headers.get("Authorization") ?? "" },
          signal: AbortSignal.timeout(5_000),
        });
        if (upstream.status === 204) {
          return new Response(null, { status: 204 });
        }
        const body = await upstream.json().catch(() => ({}));
        return Response.json(body, { status: upstream.status });
      } catch (err) {
        return Response.json({ error: `Upstream error: ${err}` }, { status: 502 });
      }
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log(`function-bun listening on port ${PORT}`);
