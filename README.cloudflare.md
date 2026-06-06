# GrokSearch Cloudflare Workers Native MCP

This branch adds a Cloudflare Workers native Remote MCP implementation of the core GrokSearch workflow.

It does not replace the original Python/FastMCP stdio server. The original Claude Code-focused implementation remains in place. This implementation is intended for ChatGPT Web custom connectors and other clients that can connect to a Streamable HTTP MCP endpoint.

## Architecture

```text
ChatGPT / MCP client
  -> https://<worker-host>/mcp
  -> Cloudflare Workers + Agents SDK McpAgent
  -> Grok/xAI web search
  -> Tavily Extract / Map
  -> Firecrawl Scrape fallback
```

Cloudflare's `McpAgent.serve('/mcp')` handles Streamable HTTP transport. The Worker exposes `/health` for a normal HTTP health check and `/mcp` for MCP clients.

## Tools

| Tool | Purpose |
| --- | --- |
| `web_search` | Runs Grok/xAI web search and returns an answer plus a `session_id`. |
| `get_sources` | Returns cached sources for a previous `web_search` call in the same MCP session. |
| `web_fetch` | Fetches a page through Tavily Extract, falling back to Firecrawl Scrape. |
| `web_map` | Discovers site URLs through Tavily Map. |
| `get_config_info` | Returns non-secret configuration diagnostics. |

Not ported in this version: `toggle_builtin_tools`, `switch_model`, Claude Code settings mutation, parent process monitoring, and local config-file persistence.

## Local setup

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

The local MCP endpoint is:

```text
http://localhost:8788/mcp
```

The endpoint is not meant to be opened directly in a browser. Use MCP Inspector or a compatible MCP client.

## Required secrets

Set production secrets with Wrangler:

```bash
npx wrangler secret put GROK_API_KEY
npx wrangler secret put TAVILY_API_KEY
npx wrangler secret put FIRECRAWL_API_KEY
```

`TAVILY_API_KEY` and `FIRECRAWL_API_KEY` are optional, but `web_fetch` and `web_map` need at least the relevant provider key.

Optional access control:

```bash
npx wrangler secret put MCP_SHARED_TOKEN
```

When `MCP_SHARED_TOKEN` is set, requests to `/mcp` must include:

```http
Authorization: Bearer <token>
```

Leave `MCP_SHARED_TOKEN` unset if your MCP client cannot send a bearer token. Do not publicly share an authless endpoint because the tools can consume paid API quotas.

## Deployment

```bash
npm run deploy
```

After deployment, use:

```text
https://grok-search-cloudflare-mcp.<account>.workers.dev/mcp
```

or your custom route:

```text
https://mcp.example.com/mcp
```

## ChatGPT connector

In ChatGPT:

```text
Settings -> Apps & Connectors -> Advanced settings -> Developer mode
Settings -> Connectors -> Create
Connector URL: https://<worker-host>/mcp
```

If `MCP_SHARED_TOKEN` is enabled, configure the client-side authorization mechanism before connecting. If the connector flow cannot attach a bearer token, leave the Worker authless temporarily and protect it later with OAuth or Cloudflare Access.

## Self-check

1. `curl https://<worker-host>/health` should return JSON with `ok: true`.
2. MCP Inspector should list five tools.
3. `get_config_info` should show configured providers without leaking key values.
4. `web_search` should return `answer`, `session_id`, and `sources_count`.
5. `get_sources` should return the cached source list from the same MCP session.
6. `web_fetch` should return page content when Tavily or Firecrawl is configured.
7. `web_map` should return discovered URLs when Tavily is configured.

## Git-based deployment note

The repository includes `.github/workflows/deploy-cloudflare.yml` as a fallback GitHub Actions deployment path. It requires these repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `GROK_API_KEY`
- Optional: `TAVILY_API_KEY`, `FIRECRAWL_API_KEY`, `MCP_SHARED_TOKEN`

Cloudflare Workers Builds can also deploy the same project from this repository when the Cloudflare dashboard connection is configured.
