import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { wrapWebContent } from "../../security/external-content.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import {
  CacheEntry,
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  withTimeout,
  writeCache,
} from "./web-shared.js";

const log = createSubsystemLogger("agents/tools/web-search");

const SEARCH_PROVIDERS = ["brave", "perplexity", "bocha"] as const;
const DEFAULT_SEARCH_COUNT = 5;
const MAX_SEARCH_COUNT = 10;
const MAX_BOCHA_SEARCH_COUNT = 50;

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const BOCHA_SEARCH_ENDPOINT = "https://api.bocha.cn/v1/web-search";
const DEFAULT_PERPLEXITY_BASE_URL = "https://openrouter.ai/api/v1";
const PERPLEXITY_DIRECT_BASE_URL = "https://api.perplexity.ai";
const DEFAULT_PERPLEXITY_MODEL = "perplexity/sonar-pro";
const PERPLEXITY_KEY_PREFIXES = ["pplx-"];
const OPENROUTER_KEY_PREFIXES = ["sk-or-"];

const SEARCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();
const BRAVE_FRESHNESS_SHORTCUTS = new Set(["pd", "pw", "pm", "py"]);
const BRAVE_FRESHNESS_RANGE = /^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/;

const WebSearchSchema = Type.Object({
  query: Type.String({ description: "Search query string." }),
  count: Type.Optional(
    Type.Number({
      description: "Number of results to return (1-10 for brave/perplexity, 1-50 for bocha).",
      minimum: 1,
      maximum: MAX_BOCHA_SEARCH_COUNT,
    }),
  ),
  country: Type.Optional(
    Type.String({
      description:
        "2-letter country code for region-specific results (e.g., 'DE', 'US', 'ALL'). Default: 'US' (Brave only).",
    }),
  ),
  search_lang: Type.Optional(
    Type.String({
      description: "ISO language code for search results (e.g., 'de', 'en', 'fr') (Brave only).",
    }),
  ),
  ui_lang: Type.Optional(
    Type.String({
      description: "ISO language code for UI elements (Brave only).",
    }),
  ),
  freshness: Type.Optional(
    Type.String({
      description:
        "Filter results by discovery time. For Brave: 'pd' (past 24h), 'pw' (past week), 'pm' (past month), 'py' (past year), or date range 'YYYY-MM-DDtoYYYY-MM-DD'. For Bocha: 'noLimit', 'pd', 'pw', 'pm', 'py', or date range 'YYYY-MM-DDtoYYYY-MM-DD'.",
    }),
  ),
  site: Type.Optional(
    Type.String({
      description: "Limit search to specific website/domain (Bocha only, e.g., 'example.com').",
    }),
  ),
  summary: Type.Optional(
    Type.Boolean({
      description: "Return text summary of search results (Bocha only, default: false).",
    }),
  ),
});

type WebSearchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { search?: infer Search }
    ? Search
    : undefined
  : undefined;

type BraveSearchResult = {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
};

type BraveSearchResponse = {
  web?: {
    results?: BraveSearchResult[];
  };
};

type BochaWebPage = {
  id?: string;
  name?: string;
  url?: string;
  displayUrl?: string;
  snippet?: string;
  siteName?: string;
  siteIcon?: string;
  datePublished?: string;
  dateLastCrawled?: string;
  cachedPageUrl?: string | null;
};

type BochaImage = {
  thumbnailUrl?: string;
  contentUrl?: string;
  hostPageUrl?: string;
  webSearchUrl?: string | null;
};

type BochaSearchResponse = {
  code?: number;
  log_id?: string;
  msg?: string | null;
  data?: {
    _type?: string;
    queryContext?: {
      originalQuery?: string;
    };
    webPages?: {
      webSearchUrl?: string;
      totalEstimatedMatches?: number;
      value?: BochaWebPage[];
      someResultsRemoved?: boolean;
    };
    images?: {
      id?: string | null;
      readLink?: string | null;
      webSearchUrl?: string | null;
      value?: BochaImage[];
      isFamilyFriendly?: boolean | null;
    };
    videos?: unknown;
  };
  summary?: string;
};

type PerplexityConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

type PerplexityApiKeySource = "config" | "perplexity_env" | "openrouter_env" | "none";

type PerplexitySearchResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  citations?: string[];
};

type PerplexityBaseUrlHint = "direct" | "openrouter";

function resolveSearchConfig(cfg?: OpenClawConfig): WebSearchConfig {
  const search = cfg?.tools?.web?.search;
  if (!search || typeof search !== "object") {
    return undefined;
  }
  return search as WebSearchConfig;
}

function resolveSearchEnabled(params: { search?: WebSearchConfig; sandboxed?: boolean }): boolean {
  if (typeof params.search?.enabled === "boolean") {
    return params.search.enabled;
  }
  if (params.sandboxed) {
    return true;
  }
  return true;
}

function resolveSearchApiKey(
  search?: WebSearchConfig,
  provider?: (typeof SEARCH_PROVIDERS)[number],
): string | undefined {
  const fromConfig =
    search && "apiKey" in search && typeof search.apiKey === "string" ? search.apiKey.trim() : "";
  if (provider === "bocha") {
    const fromEnv = (process.env.BOCHA_API_KEY ?? "").trim();
    return fromConfig || fromEnv || undefined;
  }
  const fromEnv = (process.env.BRAVE_API_KEY ?? "").trim();
  return fromConfig || fromEnv || undefined;
}

function missingSearchKeyPayload(provider: (typeof SEARCH_PROVIDERS)[number]) {
  if (provider === "perplexity") {
    return {
      error: "missing_perplexity_api_key",
      message:
        "web_search (perplexity) needs an API key. Set PERPLEXITY_API_KEY or OPENROUTER_API_KEY in the Gateway environment, or configure tools.web.search.perplexity.apiKey.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  if (provider === "bocha") {
    return {
      error: "missing_bocha_api_key",
      message: `web_search (bocha) needs a Bocha API key. Run \`${formatCliCommand("openclaw configure --section web")}\` to store it, or set BOCHA_API_KEY in the Gateway environment.`,
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  return {
    error: "missing_brave_api_key",
    message: `web_search needs a Brave Search API key. Run \`${formatCliCommand("openclaw configure --section web")}\` to store it, or set BRAVE_API_KEY in the Gateway environment.`,
    docs: "https://docs.openclaw.ai/tools/web",
  };
}

function resolveSearchProvider(search?: WebSearchConfig): (typeof SEARCH_PROVIDERS)[number] {
  const raw =
    search && "provider" in search && typeof search.provider === "string"
      ? search.provider.trim().toLowerCase()
      : "";
  if (raw === "perplexity") {
    return "perplexity";
  }
  if (raw === "brave") {
    return "brave";
  }
  if (raw === "bocha") {
    return "bocha";
  }
  return "brave";
}

function resolvePerplexityConfig(search?: WebSearchConfig): PerplexityConfig {
  if (!search || typeof search !== "object") {
    return {};
  }
  const perplexity = "perplexity" in search ? search.perplexity : undefined;
  if (!perplexity || typeof perplexity !== "object") {
    return {};
  }
  return perplexity as PerplexityConfig;
}

function resolvePerplexityApiKey(perplexity?: PerplexityConfig): {
  apiKey?: string;
  source: PerplexityApiKeySource;
} {
  const fromConfig = normalizeApiKey(perplexity?.apiKey);
  if (fromConfig) {
    return { apiKey: fromConfig, source: "config" };
  }

  const fromEnvPerplexity = normalizeApiKey(process.env.PERPLEXITY_API_KEY);
  if (fromEnvPerplexity) {
    return { apiKey: fromEnvPerplexity, source: "perplexity_env" };
  }

  const fromEnvOpenRouter = normalizeApiKey(process.env.OPENROUTER_API_KEY);
  if (fromEnvOpenRouter) {
    return { apiKey: fromEnvOpenRouter, source: "openrouter_env" };
  }

  return { apiKey: undefined, source: "none" };
}

function normalizeApiKey(key: unknown): string {
  return typeof key === "string" ? key.trim() : "";
}

function inferPerplexityBaseUrlFromApiKey(apiKey?: string): PerplexityBaseUrlHint | undefined {
  if (!apiKey) {
    return undefined;
  }
  const normalized = apiKey.toLowerCase();
  if (PERPLEXITY_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "direct";
  }
  if (OPENROUTER_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "openrouter";
  }
  return undefined;
}

function resolvePerplexityBaseUrl(
  perplexity?: PerplexityConfig,
  apiKeySource: PerplexityApiKeySource = "none",
  apiKey?: string,
): string {
  const fromConfig =
    perplexity && "baseUrl" in perplexity && typeof perplexity.baseUrl === "string"
      ? perplexity.baseUrl.trim()
      : "";
  if (fromConfig) {
    return fromConfig;
  }
  if (apiKeySource === "perplexity_env") {
    return PERPLEXITY_DIRECT_BASE_URL;
  }
  if (apiKeySource === "openrouter_env") {
    return DEFAULT_PERPLEXITY_BASE_URL;
  }
  if (apiKeySource === "config") {
    const inferred = inferPerplexityBaseUrlFromApiKey(apiKey);
    if (inferred === "direct") {
      return PERPLEXITY_DIRECT_BASE_URL;
    }
    if (inferred === "openrouter") {
      return DEFAULT_PERPLEXITY_BASE_URL;
    }
  }
  return DEFAULT_PERPLEXITY_BASE_URL;
}

function resolvePerplexityModel(perplexity?: PerplexityConfig): string {
  const fromConfig =
    perplexity && "model" in perplexity && typeof perplexity.model === "string"
      ? perplexity.model.trim()
      : "";
  return fromConfig || DEFAULT_PERPLEXITY_MODEL;
}

function resolveSearchCount(
  value: unknown,
  fallback: number,
  provider?: (typeof SEARCH_PROVIDERS)[number],
): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const maxCount = provider === "bocha" ? MAX_BOCHA_SEARCH_COUNT : MAX_SEARCH_COUNT;
  const clamped = Math.max(1, Math.min(maxCount, Math.floor(parsed)));
  return clamped;
}

function normalizeFreshness(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const lower = trimmed.toLowerCase();
  if (BRAVE_FRESHNESS_SHORTCUTS.has(lower)) {
    return lower;
  }

  const match = trimmed.match(BRAVE_FRESHNESS_RANGE);
  if (!match) {
    return undefined;
  }

  const [, start, end] = match;
  if (!isValidIsoDate(start) || !isValidIsoDate(end)) {
    return undefined;
  }
  if (start > end) {
    return undefined;
  }

  return `${start}to${end}`;
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return false;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function resolveSiteName(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

async function runPerplexitySearch(params: {
  query: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
}): Promise<{ content: string; citations: string[] }> {
  const endpoint = `${params.baseUrl.replace(/\/$/, "")}/chat/completions`;

  const requestBody = {
    model: params.model,
    messages: [
      {
        role: "user",
        content: params.query,
      },
    ],
  };

  log.info("Perplexity search request", {
    provider: "perplexity",
    query: params.query,
    model: params.model,
    baseUrl: params.baseUrl,
    endpoint,
    requestBody,
  });

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
      "HTTP-Referer": "https://openclaw.ai",
      "X-Title": "OpenClaw Web Search",
    },
    body: JSON.stringify(requestBody),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detail = await readResponseText(res);
    throw new Error(`Perplexity API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as PerplexitySearchResponse;
  const content = data.choices?.[0]?.message?.content ?? "No response";
  const citations = data.citations ?? [];

  log.info("Perplexity search response", {
    provider: "perplexity",
    query: params.query,
    status: res.status,
    contentLength: content.length,
    citationsCount: citations.length,
    citations,
    response: data,
  });

  return { content, citations };
}

async function runBochaSearch(params: {
  query: string;
  count: number;
  apiKey: string;
  timeoutSeconds: number;
  freshness?: string;
  site?: string;
  summary?: boolean;
}): Promise<{
  results: Array<{
    title?: string;
    url?: string;
    description?: string;
    siteName?: string;
    siteIcon?: string;
    published?: string;
    imageUrl?: string;
  }>;
  summary?: string;
}> {
  const body: Record<string, unknown> = {
    query: params.query,
    count: params.count,
  };

  if (params.summary !== undefined) {
    body.summary = params.summary;
  }

  if (params.freshness) {
    body.freshness = params.freshness;
  } else {
    body.freshness = "noLimit";
  }

  if (params.site) {
    body.site = params.site;
  }

  log.info("Bocha search request", {
    provider: "bocha",
    query: params.query,
    count: params.count,
    freshness: body.freshness,
    site: params.site,
    summary: params.summary,
    endpoint: BOCHA_SEARCH_ENDPOINT,
    requestBody: body,
  });

  const res = await fetch(BOCHA_SEARCH_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detail = await readResponseText(res);
    throw new Error(`Bocha Search API error (${res.status}): ${detail || res.statusText}`);
  }

  const response = (await res.json()) as BochaSearchResponse;

  // Extract web pages from the nested structure
  const webPages = response.data?.webPages?.value ?? [];
  const images = response.data?.images?.value ?? [];

  // Create a map of images by host page URL for quick lookup
  const imageMap = new Map<string, string>();
  for (const img of images) {
    if (img.hostPageUrl && img.thumbnailUrl) {
      imageMap.set(img.hostPageUrl, img.thumbnailUrl);
    }
  }

  // Map web pages to our result format
  const results = webPages.map((page) => {
    const imageUrl = page.url ? imageMap.get(page.url) : undefined;
    return {
      title: page.name,
      url: page.url,
      description: page.snippet,
      siteName: page.siteName,
      siteIcon: page.siteIcon,
      published: page.datePublished,
      imageUrl,
    };
  });

  const summary = response.summary;

  log.info("Bocha search response", {
    provider: "bocha",
    query: params.query,
    status: res.status,
    resultsCount: results.length,
    hasSummary: !!summary,
    response,
  });

  return { results, summary };
}

async function runWebSearch(params: {
  query: string;
  count: number;
  apiKey: string;
  timeoutSeconds: number;
  cacheTtlMs: number;
  provider: (typeof SEARCH_PROVIDERS)[number];
  country?: string;
  search_lang?: string;
  ui_lang?: string;
  freshness?: string;
  perplexityBaseUrl?: string;
  perplexityModel?: string;
  site?: string;
  summary?: boolean;
}): Promise<Record<string, unknown>> {
  const cacheKey = normalizeCacheKey(
    params.provider === "brave"
      ? `${params.provider}:${params.query}:${params.count}:${params.country || "default"}:${params.search_lang || "default"}:${params.ui_lang || "default"}:${params.freshness || "default"}`
      : params.provider === "bocha"
        ? `${params.provider}:${params.query}:${params.count}:${params.freshness || "default"}:${params.site || "default"}:${params.summary || false}`
        : `${params.provider}:${params.query}:${params.count}:${params.country || "default"}:${params.search_lang || "default"}:${params.ui_lang || "default"}`,
  );
  const cached = readCache(SEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const start = Date.now();

  if (params.provider === "perplexity") {
    const { content, citations } = await runPerplexitySearch({
      query: params.query,
      apiKey: params.apiKey,
      baseUrl: params.perplexityBaseUrl ?? DEFAULT_PERPLEXITY_BASE_URL,
      model: params.perplexityModel ?? DEFAULT_PERPLEXITY_MODEL,
      timeoutSeconds: params.timeoutSeconds,
    });

    const payload = {
      query: params.query,
      provider: params.provider,
      model: params.perplexityModel ?? DEFAULT_PERPLEXITY_MODEL,
      tookMs: Date.now() - start,
      content: wrapWebContent(content),
      citations,
    };
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  if (params.provider === "bocha") {
    const { results, summary } = await runBochaSearch({
      query: params.query,
      count: params.count,
      apiKey: params.apiKey,
      timeoutSeconds: params.timeoutSeconds,
      freshness: params.freshness,
      site: params.site,
      summary: params.summary,
    });

    const mapped = results.map((entry) => {
      const description = entry.description ?? "";
      const title = entry.title ?? "";
      const url = entry.url ?? "";
      return {
        title: title ? wrapWebContent(title, "web_search") : "",
        url, // Keep raw for tool chaining
        description: description ? wrapWebContent(description, "web_search") : "",
        published: entry.published || undefined,
        siteName: entry.siteName || undefined,
        siteIcon: entry.siteIcon || undefined,
        imageUrl: entry.imageUrl || undefined,
      };
    });

    const payload: Record<string, unknown> = {
      query: params.query,
      provider: params.provider,
      count: mapped.length,
      tookMs: Date.now() - start,
      results: mapped,
    };

    if (summary) {
      payload.summary = wrapWebContent(summary);
    }

    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  if (params.provider !== "brave") {
    throw new Error("Unsupported web search provider.");
  }

  const url = new URL(BRAVE_SEARCH_ENDPOINT);
  url.searchParams.set("q", params.query);
  url.searchParams.set("count", String(params.count));
  if (params.country) {
    url.searchParams.set("country", params.country);
  }
  if (params.search_lang) {
    url.searchParams.set("search_lang", params.search_lang);
  }
  if (params.ui_lang) {
    url.searchParams.set("ui_lang", params.ui_lang);
  }
  if (params.freshness) {
    url.searchParams.set("freshness", params.freshness);
  }

  log.info("Brave search request", {
    provider: "brave",
    query: params.query,
    count: params.count,
    country: params.country,
    search_lang: params.search_lang,
    ui_lang: params.ui_lang,
    freshness: params.freshness,
    url: url.toString(),
  });

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": params.apiKey,
    },
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detail = await readResponseText(res);
    throw new Error(`Brave Search API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as BraveSearchResponse;
  const results = Array.isArray(data.web?.results) ? (data.web?.results ?? []) : [];
  const mapped = results.map((entry) => {
    const description = entry.description ?? "";
    const title = entry.title ?? "";
    const url = entry.url ?? "";
    const rawSiteName = resolveSiteName(url);
    return {
      title: title ? wrapWebContent(title, "web_search") : "",
      url, // Keep raw for tool chaining
      description: description ? wrapWebContent(description, "web_search") : "",
      published: entry.age || undefined,
      siteName: rawSiteName || undefined,
    };
  });

  log.info("Brave search response", {
    provider: "brave",
    query: params.query,
    status: res.status,
    resultsCount: mapped.length,
    response: data,
  });

  const payload = {
    query: params.query,
    provider: params.provider,
    count: mapped.length,
    tookMs: Date.now() - start,
    results: mapped,
  };
  writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
  return payload;
}

export function createWebSearchTool(options?: {
  config?: OpenClawConfig;
  sandboxed?: boolean;
}): AnyAgentTool | null {
  const search = resolveSearchConfig(options?.config);
  if (!resolveSearchEnabled({ search, sandboxed: options?.sandboxed })) {
    return null;
  }

  const provider = resolveSearchProvider(search);
  const perplexityConfig = resolvePerplexityConfig(search);

  const description =
    provider === "perplexity"
      ? "Search the web using Perplexity Sonar (direct or via OpenRouter). Returns AI-synthesized answers with citations from real-time web search."
      : provider === "bocha"
        ? "Search the web using Bocha Search API. Supports natural language queries, time range filtering, site-specific search, and text summaries. Returns up to 50 results with titles, URLs, descriptions, site names, icons, publish dates, and image links."
        : "Search the web using Brave Search API. Supports region-specific and localized search via country and language parameters. Returns titles, URLs, and snippets for fast research.";

  return {
    label: "Web Search",
    name: "web_search",
    description,
    parameters: WebSearchSchema,
    execute: async (_toolCallId, args) => {
      const perplexityAuth =
        provider === "perplexity" ? resolvePerplexityApiKey(perplexityConfig) : undefined;
      const apiKey =
        provider === "perplexity" ? perplexityAuth?.apiKey : resolveSearchApiKey(search, provider);

      if (!apiKey) {
        return jsonResult(missingSearchKeyPayload(provider));
      }
      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const count =
        readNumberParam(params, "count", { integer: true }) ?? search?.maxResults ?? undefined;
      const country = readStringParam(params, "country");
      const search_lang = readStringParam(params, "search_lang");
      const ui_lang = readStringParam(params, "ui_lang");
      const rawFreshness = readStringParam(params, "freshness");
      const site = readStringParam(params, "site");
      const summary = params.summary !== undefined ? Boolean(params.summary) : undefined;

      if (country && provider !== "brave") {
        return jsonResult({
          error: "unsupported_country",
          message: "country is only supported by the Brave web_search provider.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      if (search_lang && provider !== "brave") {
        return jsonResult({
          error: "unsupported_search_lang",
          message: "search_lang is only supported by the Brave web_search provider.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      if (ui_lang && provider !== "brave") {
        return jsonResult({
          error: "unsupported_ui_lang",
          message: "ui_lang is only supported by the Brave web_search provider.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      if (site && provider !== "bocha") {
        return jsonResult({
          error: "unsupported_site",
          message: "site is only supported by the Bocha web_search provider.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      if (summary !== undefined && provider !== "bocha") {
        return jsonResult({
          error: "unsupported_summary",
          message: "summary is only supported by the Bocha web_search provider.",
          docs: "https://docs.openclaw.ai/tools/web",
        });
      }
      let freshness: string | undefined;
      if (rawFreshness) {
        if (provider === "bocha") {
          // Bocha supports: "noLimit", "pd", "pw", "pm", "py", or date range
          const trimmed = rawFreshness.trim();
          if (
            trimmed === "noLimit" ||
            trimmed === "pd" ||
            trimmed === "pw" ||
            trimmed === "pm" ||
            trimmed === "py"
          ) {
            freshness = trimmed;
          } else {
            // Try to validate as date range
            const normalized = normalizeFreshness(rawFreshness);
            if (normalized) {
              freshness = normalized;
            } else {
              return jsonResult({
                error: "invalid_freshness",
                message:
                  "freshness must be one of 'noLimit', 'pd', 'pw', 'pm', 'py', or a date range like YYYY-MM-DDtoYYYY-MM-DD.",
                docs: "https://docs.openclaw.ai/tools/web",
              });
            }
          }
        } else {
          // Brave uses normalizeFreshness
          freshness = normalizeFreshness(rawFreshness);
          if (!freshness) {
            return jsonResult({
              error: "invalid_freshness",
              message:
                "freshness must be one of pd, pw, pm, py, or a range like YYYY-MM-DDtoYYYY-MM-DD.",
              docs: "https://docs.openclaw.ai/tools/web",
            });
          }
        }
      }
      const result = await runWebSearch({
        query,
        count: resolveSearchCount(count, DEFAULT_SEARCH_COUNT, provider),
        apiKey,
        timeoutSeconds: resolveTimeoutSeconds(search?.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS),
        cacheTtlMs: resolveCacheTtlMs(search?.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES),
        provider,
        country,
        search_lang,
        ui_lang,
        freshness,
        perplexityBaseUrl: resolvePerplexityBaseUrl(
          perplexityConfig,
          perplexityAuth?.source,
          perplexityAuth?.apiKey,
        ),
        perplexityModel: resolvePerplexityModel(perplexityConfig),
        site,
        summary,
      });
      return jsonResult(result);
    },
  };
}

export const __testing = {
  inferPerplexityBaseUrlFromApiKey,
  resolvePerplexityBaseUrl,
  normalizeFreshness,
} as const;
