import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface Env extends Cloudflare.Env {
  GROK_API_KEY?: string;
  GROK_API_URL?: string;
  GROK_MODEL?: string;
  TAVILY_API_KEY?: string;
  TAVILY_API_URL?: string;
  FIRECRAWL_API_KEY?: string;
  FIRECRAWL_API_URL?: string;
  MCP_SHARED_TOKEN?: string;
  MAX_TOOL_RESULT_CHARS?: string;
  MAX_SOURCES?: string;
}

type Source = {
  id: string;
  title?: string;
  url: string;
  snippet?: string;
  provider: "grok" | "tavily" | "firecrawl";
  retrieved_at: string;
};

type SearchSession = {
  query: string;
  answer_preview: string;
  sources: Source[];
  created_at: string;
  model?: string;
};

type AgentState = {
  sessions: Record<string, SearchSession>;
  selected_model?: string;
};

type FetchResult = {
  url: string;
  title?: string;
  content: string;
  provider: "tavily" | "firecrawl";
};

type GrokModelInfo = {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
};

const SERVER_NAME = "grok-search-cloudflare-mcp";
const SERVER_VERSION = "0.1.0";
const DEFAULT_GROK_MODEL = "grok-4-fast";
const DEFAULT_STATE: AgentState = { sessions: {} };

function envOf(agent: unknown): Env {
  return (agent as { env: Env }).env;
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function fail(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { error: { code, message, retryable: false, ...extra } };
}

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function maxNumber(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value || fallback);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

function now() {
  return new Date().toISOString();
}

function sessionId() {
  return `search_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

function normalizeHttpUrl(input: string) {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https URLs are supported.");
  url.hash = "";
  return url.toString();
}

function truncate(text: string, limit: number) {
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}\n\n[truncated]`, truncated: true };
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function grokBaseUrl(env: Env) {
  return trimSlash(env.GROK_API_URL || "https://api.x.ai/v1");
}

function defaultGrokModel(env: Env) {
  return env.GROK_MODEL || DEFAULT_GROK_MODEL;
}

function currentGrokModel(env: Env, state?: AgentState) {
  return state?.selected_model || defaultGrokModel(env);
}

function normalizeGrokModels(value: unknown): GrokModelInfo[] {
  const root = rec(value);
  const rawItems = Array.isArray(root.data)
    ? root.data
    : Array.isArray(root.models)
      ? root.models
      : Array.isArray(value)
        ? value
        : [];

  const seen = new Set<string>();
  const models: GrokModelInfo[] = [];

  for (const item of rawItems) {
    if (typeof item === "string") {
      if (!seen.has(item)) {
        seen.add(item);
        models.push({ id: item });
      }
      continue;
    }

    const model = rec(item);
    const id = typeof model.id === "string" ? model.id : typeof model.name === "string" ? model.name : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      object: typeof model.object === "string" ? model.object : undefined,
      created: typeof model.created === "number" ? model.created : undefined,
      owned_by: typeof model.owned_by === "string" ? model.owned_by : undefined,
    });
  }

  return models;
}

async function listGrokModels(env: Env): Promise<{ api_url: string; models: GrokModelInfo[]; count: number } | ReturnType<typeof fail>> {
  if (!env.GROK_API_KEY) return fail("missing_config", "GROK_API_KEY is not configured.", { provider: "grok" });

  const apiUrl = grokBaseUrl(env);
  const response = await fetchJson(`${apiUrl}/models`, {
    method: "GET",
    headers: { Authorization: `Bearer ${env.GROK_API_KEY}`, "Content-Type": "application/json" },
  }, 30000);

  if (!response.ok) {
    return fail("provider_error", `Grok models API returned HTTP ${response.status}.`, { provider: "grok", status: response.status, retryable: response.status === 429 || response.status >= 500 });
  }

  const models = normalizeGrokModels(response.data);
  return { api_url: apiUrl, models, count: models.length };
}

function textFromRaw(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("<")) return "";
  try {
    return textFrom(JSON.parse(trimmed));
  } catch {}
  if (!trimmed.includes("data:")) return trimmed;
  const chunks: string[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const item = line.trim();
    if (!item.startsWith("data:")) continue;
    const data = item.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const text = textFrom(JSON.parse(data));
      if (text) chunks.push(text);
    } catch {}
  }
  return chunks.join("");
}

function textFrom(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFrom).filter(Boolean).join("\n");
  const o = rec(value);
  if (o.message) return textFrom(o.message);
  if (typeof o.output_text === "string") return o.output_text;
  if (typeof o.answer === "string") return o.answer;
  if (typeof o.result === "string") return o.result;
  if (typeof o.response === "string") return o.response;
  if (typeof o.text === "string") return o.text;
  if (typeof o.content === "string") return o.content;
  if (Array.isArray(o.content)) return textFrom(o.content);
  if (Array.isArray(o.output)) return textFrom(o.output);
  if (Array.isArray(o.data)) return textFrom(o.data);
  if (Array.isArray(o.choices)) return o.choices.map((c) => textFrom(rec(c).message ?? rec(c).delta ?? rec(c).text ?? c)).filter(Boolean).join("\n");
  if (typeof o.raw === "string") return textFromRaw(o.raw);
  return "";
}

function sourcesFrom(value: unknown, provider: Source["provider"], limit: number): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  const visit = (node: unknown) => {
    if (!node || out.length >= limit) return;
    if (Array.isArray(node)) { for (const item of node) visit(item); return; }
    if (typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    const rawUrl = o.url || o.uri || o.href;
    if (typeof rawUrl === "string") {
      try {
        const url = normalizeHttpUrl(rawUrl);
        if (!seen.has(url)) {
          seen.add(url);
          out.push({
            id: crypto.randomUUID(),
            url,
            title: typeof o.title === "string" ? o.title : undefined,
            snippet: typeof o.snippet === "string" ? o.snippet : typeof o.description === "string" ? o.description : undefined,
            provider,
            retrieved_at: now(),
          });
        }
      } catch {}
    }
    for (const key of ["citations", "annotations", "references", "sources", "results", "search_results"]) visit(o[key]);
  };
  visit(value);
  return out;
}

function sourcesFromText(text: string, provider: Source["provider"], limit: number): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  const markdownLink = /\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/g;
  const bareUrl = /https?:\/\/[^\s)\]]+/g;
  for (const pattern of [markdownLink, bareUrl]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) && out.length < limit) {
      const rawUrl = match[1] || match[0];
      try {
        const url = normalizeHttpUrl(rawUrl);
        if (seen.has(url)) continue;
        seen.add(url);
        out.push({ id: crypto.randomUUID(), url, provider, retrieved_at: now() });
      } catch {}
    }
  }
  return out;
}

function injectTimeContext(query: string) {
  const terms = ["latest", "recent", "today", "current", "now", "最新", "今天", "当前", "最近", "实时"];
  const lower = query.toLowerCase();
  if (!terms.some((term) => lower.includes(term))) return query;
  return `Current date: ${new Date().toISOString().slice(0, 10)}. User query: ${query}`;
}

async function callGrok(env: Env, model: string, query: string, opts: { max_sources?: number; allowed_domains?: string[]; excluded_domains?: string[]; include_images?: boolean }) {
  if (!env.GROK_API_KEY) return fail("missing_config", "GROK_API_KEY is not configured.", { provider: "grok" });
  const base = grokBaseUrl(env);
  const headers = { Authorization: `Bearer ${env.GROK_API_KEY}`, "Content-Type": "application/json" };
  const maxSources = opts.max_sources || maxNumber(env.MAX_SOURCES, 20, 1, 100);
  const body = {
    model,
    input: injectTimeContext(query),
    tools: [{ type: "web_search", max_search_results: maxSources, allowed_domains: opts.allowed_domains, excluded_domains: opts.excluded_domains, include_images: opts.include_images }],
  };
  const callChatCompletions = () => fetchJson(`${base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: injectTimeContext(query) }],
        stream: true,
        search_parameters: { mode: "auto", max_search_results: maxSources, allowed_domains: opts.allowed_domains, excluded_domains: opts.excluded_domains },
      }),
    }, 60000);
  let response = await fetchJson(`${base}/responses`, { method: "POST", headers, body: JSON.stringify(body) }, 60000);
  if (!response.ok) {
    response = await callChatCompletions();
  } else if (response.ok && !textFrom(response.data).trim()) {
    const fallback = await callChatCompletions();
    if (fallback.ok || !response.ok) response = fallback;
  }
  if (!response.ok) return fail("provider_error", `Grok API returned HTTP ${response.status}.`, { provider: "grok", status: response.status, retryable: response.status === 429 || response.status >= 500 });
  const answer = textFrom(response.data).trim() || "No textual answer was returned.";
  const structuredSources = sourcesFrom(response.data, "grok", maxSources);
  const textSources = sourcesFromText(answer, "grok", Math.max(maxSources - structuredSources.length, 0));
  let sources = [...structuredSources, ...textSources];
  if (!sources.length && env.TAVILY_API_KEY) sources = await tavilySearchSources(env, query, maxSources);
  return { answer, sources, model };
}

async function tavilySearchSources(env: Env, query: string, maxResults: number): Promise<Source[]> {
  const response = await fetchJson(`${trimSlash(env.TAVILY_API_URL || "https://api.tavily.com")}/search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.TAVILY_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, max_results: maxResults, search_depth: "basic", include_answer: false }),
  }, 30000);
  if (!response.ok) return [];
  return sourcesFrom(response.data, "tavily", maxResults);
}

async function tavilyExtract(env: Env, url: string, format: "markdown" | "text" | "html"): Promise<FetchResult | null> {
  if (!env.TAVILY_API_KEY) return null;
  const response = await fetchJson(`${trimSlash(env.TAVILY_API_URL || "https://api.tavily.com")}/extract`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.TAVILY_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ urls: [url], extract_depth: "advanced", format: format === "html" ? "html" : "markdown" }),
  }, 30000);
  if (!response.ok) return null;
  const results = rec(response.data).results;
  const first = rec((Array.isArray(results) ? results : [])[0]);
  const content = typeof first.raw_content === "string" ? first.raw_content : typeof first.content === "string" ? first.content : "";
  if (!content.trim()) return null;
  return { url: typeof first.url === "string" ? first.url : url, title: typeof first.title === "string" ? first.title : undefined, content, provider: "tavily" as const };
}

async function firecrawlScrape(env: Env, url: string, format: "markdown" | "text" | "html"): Promise<FetchResult | ReturnType<typeof fail> | null> {
  if (!env.FIRECRAWL_API_KEY) return null;
  const response = await fetchJson(`${trimSlash(env.FIRECRAWL_API_URL || "https://api.firecrawl.dev/v2")}/scrape`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.FIRECRAWL_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url, formats: [format === "html" ? "html" : "markdown"] }),
  }, 45000);
  if (!response.ok) return fail("provider_error", `Firecrawl API returned HTTP ${response.status}.`, { provider: "firecrawl", status: response.status, retryable: response.status === 429 || response.status >= 500 });
  const data = rec(rec(response.data).data || response.data);
  const metadata = rec(data.metadata);
  const content = format === "html" && typeof data.html === "string" ? data.html : typeof data.markdown === "string" ? data.markdown : typeof data.content === "string" ? data.content : typeof data.summary === "string" ? data.summary : "";
  if (!content.trim()) return null;
  return { url, title: typeof metadata.title === "string" ? metadata.title : undefined, content, provider: "firecrawl" as const };
}

async function tavilyMap(env: Env, url: string, input: { instructions?: string; max_depth?: number; max_pages?: number }) {
  if (!env.TAVILY_API_KEY) return fail("missing_config", "TAVILY_API_KEY is required for web_map.", { provider: "tavily" });
  const limit = Math.min(Math.max(input.max_pages || 50, 1), 500);
  const response = await fetchJson(`${trimSlash(env.TAVILY_API_URL || "https://api.tavily.com")}/map`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.TAVILY_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url, instructions: input.instructions || undefined, max_depth: Math.min(Math.max(input.max_depth || 1, 1), 5), limit }),
  }, 45000);
  if (!response.ok) return fail("provider_error", `Tavily Map returned HTTP ${response.status}.`, { provider: "tavily", status: response.status, retryable: response.status === 429 || response.status >= 500 });
  const data = rec(response.data);
  const urls = (Array.isArray(data.results) ? data.results : []).filter((item): item is string => typeof item === "string").slice(0, limit);
  return { base_url: typeof data.base_url === "string" ? data.base_url : url, urls, count: urls.length, provider: "tavily" };
}

function isAuthorized(request: Request, env: Env) {
  if (!env.MCP_SHARED_TOKEN) return true;
  return request.headers.get("Authorization") === `Bearer ${env.MCP_SHARED_TOKEN}`;
}

export class GrokSearchMCP extends McpAgent<Env, AgentState> {
  initialState: AgentState = DEFAULT_STATE;
  server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  async init() {
    this.server.registerTool("web_search", {
      title: "Grok web search",
      description: "Run Grok/xAI web search and cache returned source metadata.",
      inputSchema: { query: z.string().min(1), max_sources: z.number().int().min(1).max(50).optional(), allowed_domains: z.array(z.string()).optional(), excluded_domains: z.array(z.string()).optional(), include_images: z.boolean().optional() },
    }, async (input) => {
      const env = envOf(this);
      const model = currentGrokModel(env, this.state);
      const result = await callGrok(env, model, input.query, input);
      if ("error" in result) return json(result);
      const id = sessionId();
      this.setState({ ...(this.state || DEFAULT_STATE), sessions: { ...(this.state?.sessions || {}), [id]: { query: input.query, answer_preview: result.answer.slice(0, 500), sources: result.sources, created_at: now(), model: result.model } } });
      return json({ session_id: id, answer: result.answer, sources_count: result.sources.length, sources_preview: result.sources.slice(0, 5), model: result.model });
    });

    this.server.registerTool("get_sources", {
      title: "Get cached sources",
      description: "Return source metadata cached by a previous web_search call in this MCP session.",
      inputSchema: { session_id: z.string().min(1) },
    }, async ({ session_id }) => {
      const session = this.state?.sessions?.[session_id];
      if (!session) return json(fail("session_not_found", "No cached sources were found for this session_id."));
      return json({ session_id, query: session.query, created_at: session.created_at, model: session.model, sources_count: session.sources.length, sources: session.sources });
    });

    this.server.registerTool("list_models", {
      title: "List Grok models",
      description: "Fetch available models from the configured Grok/xAI-compatible API base URL.",
      inputSchema: {},
    }, async () => {
      const env = envOf(this);
      const result = await listGrokModels(env);
      if ("error" in result) return json(result);
      return json({
        ...result,
        default_model: defaultGrokModel(env),
        selected_model: this.state?.selected_model || null,
        current_model: currentGrokModel(env, this.state),
      });
    });

    this.server.registerTool("switch_model", {
      title: "Switch Grok model",
      description: "Switch the Grok model for the current MCP session without changing Worker environment variables.",
      inputSchema: { model: z.string().min(1) },
    }, async ({ model }) => {
      const env = envOf(this);
      const requestedModel = model.trim();
      if (!requestedModel) return json(fail("invalid_input", "Model must not be empty."));

      const previousModel = currentGrokModel(env, this.state);
      const listed = await listGrokModels(env);
      let validation: Record<string, unknown> = { checked: false };

      if ("error" in listed) {
        validation = { checked: false, warning: "Could not validate model against /models; switching anyway.", details: listed.error };
      } else {
        const availableModels = listed.models.map((item) => item.id);
        if (!availableModels.includes(requestedModel)) {
          return json(fail("model_not_found", `Model '${requestedModel}' was not returned by /models.`, { available_models: availableModels, checked: true }));
        }
        validation = { checked: true, available_count: listed.count };
      }

      this.setState({ ...(this.state || DEFAULT_STATE), sessions: { ...(this.state?.sessions || {}) }, selected_model: requestedModel });
      return json({ previous_model: previousModel, current_model: requestedModel, default_model: defaultGrokModel(env), validation });
    });

    this.server.registerTool("web_fetch", {
      title: "Fetch web page",
      description: "Fetch a page with Tavily Extract, falling back to Firecrawl Scrape.",
      inputSchema: { url: z.string().url(), format: z.enum(["markdown", "text", "html"]).optional(), max_chars: z.number().int().min(1000).max(100000).optional() },
    }, async ({ url, format = "markdown", max_chars }) => {
      const env = envOf(this);
      let normalized = "";
      try { normalized = normalizeHttpUrl(url); } catch (error) { return json(fail("invalid_input", error instanceof Error ? error.message : "Invalid URL.")); }
      if (!env.TAVILY_API_KEY && !env.FIRECRAWL_API_KEY) return json(fail("missing_config", "Configure TAVILY_API_KEY or FIRECRAWL_API_KEY to use web_fetch."));
      let fetched: FetchResult | ReturnType<typeof fail> | null = await tavilyExtract(env, normalized, format);
      if (!fetched) fetched = await firecrawlScrape(env, normalized, format);
      if (!fetched) return json(fail("empty_content", "The page could not be fetched or returned empty content.", { retryable: true }));
      if ("error" in fetched) return json(fetched);
      const output = truncate(fetched.content, max_chars || maxNumber(env.MAX_TOOL_RESULT_CHARS, 30000, 1000, 100000));
      return json({ url: fetched.url, title: fetched.title, content: output.text, provider: fetched.provider, truncated: output.truncated, char_count: fetched.content.length });
    });

    this.server.registerTool("web_map", {
      title: "Map web site",
      description: "Discover URLs from a website through Tavily Map.",
      inputSchema: { url: z.string().url(), instructions: z.string().optional(), max_depth: z.number().int().min(1).max(5).optional(), max_pages: z.number().int().min(1).max(500).optional() },
    }, async (input) => {
      let normalized = "";
      try { normalized = normalizeHttpUrl(input.url); } catch (error) { return json(fail("invalid_input", error instanceof Error ? error.message : "Invalid URL.")); }
      return json(await tavilyMap(envOf(this), normalized, input));
    });

    this.server.registerTool("get_config_info", {
      title: "Configuration diagnostics",
      description: "Show non-secret configuration and available providers.",
      inputSchema: {},
    }, async () => {
      const env = envOf(this);
      return json({
        server: SERVER_NAME,
        version: SERVER_VERSION,
        grok: {
          configured: Boolean(env.GROK_API_KEY),
          api_url: grokBaseUrl(env),
          default_model: defaultGrokModel(env),
          selected_model: this.state?.selected_model || null,
          current_model: currentGrokModel(env, this.state),
        },
        tavily: { configured: Boolean(env.TAVILY_API_KEY), api_url: env.TAVILY_API_URL || "https://api.tavily.com" },
        firecrawl: { configured: Boolean(env.FIRECRAWL_API_KEY), api_url: env.FIRECRAWL_API_URL || "https://api.firecrawl.dev/v2" },
        auth: { enabled: Boolean(env.MCP_SHARED_TOKEN) },
        tools: ["web_search", "get_sources", "list_models", "switch_model", "web_fetch", "web_map", "get_config_info"],
      });
    });
  }
}

const mcpHandler = GrokSearchMCP.serve("/mcp");

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Authorization,Content-Type,Mcp-Session-Id,Last-Event-ID" } });
    if (url.pathname === "/" || url.pathname === "/health") return Response.json({ ok: true, server: SERVER_NAME, version: SERVER_VERSION, mcp: "/mcp" });
    if (url.pathname === "/mcp") {
      if (!isAuthorized(request, env)) return Response.json(fail("unauthorized", "Invalid or missing bearer token."), { status: 401 });
      return mcpHandler.fetch(request, env, ctx);
    }
    return new Response("Not found", { status: 404 });
  },
};