import type { Engine } from "@culpritsql/plan-viewer";

export type ShareStudioMode = "plan" | "compare" | "deadlock";

export interface SharePayloadV1 {
  v: 1;
  m: ShareStudioMode;
  t?: string;
  e?: Engine;
  q?: string;
  p?: string;
  na?: string;
  pa?: string;
  nb?: string;
  pb?: string;
  d?: string;
}

export const EXPLAIN_ONLINE_ORIGIN = "https://explain.culpritsql.com";
const MAX_HASH_CHARS = 28_000;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  const encoded =
    typeof btoa === "function"
      ? btoa(binary)
      : Buffer.from(bytes).toString("base64");
  return encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function fromBase64Url(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  if (typeof atob === "function") {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  return new Uint8Array(Buffer.from(padded, "base64"));
}

async function compressDeflateRaw(input: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(input)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

async function decompressDeflateRaw(input: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(input)]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Scrubs SQL string, hex, and numeric literals (preserving parameter markers like $1/@p1 and 0/1 flags).
 */
export function scrubSqlLiterals(text: string): string {
  return text
    .replace(/N?'(?:''|[^'])*'/g, "'?'")
    .replace(/\b0x[0-9a-fA-F]+\b/g, "0x?")
    .replace(/(?<![$@])\b\d+(?:\.\d+)?\b/g, (num) => (num === "0" || num === "1" ? num : "?"));
}

function unescapeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x9;/gi, "\t")
    .replace(/&#xA;/gi, "\n")
    .replace(/&#xD;/gi, "\r")
    .replace(/&amp;/g, "&");
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlAttr(value: string): string {
  return escapeXmlText(value)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/\t/g, "&#x9;")
    .replace(/\n/g, "&#xA;")
    .replace(/\r/g, "&#xD;");
}

const JSON_PREDICATE_KEYS = new Set([
  "Query Text",
  "query",
  "Filter",
  "Index Cond",
  "Recheck Cond",
  "Hash Cond",
  "Merge Cond",
  "Join Filter",
  "One-Time Filter",
  "Conflict Filter",
  "TID Cond",
  "Storage Filter",
  "Storage Index Filter",
  "attached_condition",
  "pushed_index_condition",
]);

function redactJsonValue(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    if (key && JSON_PREDICATE_KEYS.has(key)) {
      return scrubSqlLiterals(value);
    }
    if (value.includes("'")) {
      return value.replace(/N?'(?:''|[^'])*'/g, "'?'");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactJsonValue(v, k);
    }
    return out;
  }
  return value;
}

const TEXT_MEASURE_KEYS = new Set([
  "buffers",
  "planning",
  "planning time",
  "execution time",
  "workers planned",
  "workers launched",
  "sort method",
  "heap blocks",
  "batches",
  "memory usage",
  "i/o timings",
  "jit",
  "functions",
  "options",
  "timing",
  "rows removed by filter",
  "rows removed by index recheck",
  "rows removed by join filter",
  "heap fetches",
  "peak memory usage",
  "disk usage",
  "cache hits",
  "cache misses",
  "cache evictions",
  "hits",
  "misses",
  "evictions",
]);

function redactExplainTextLine(line: string): string {
  const markers = ["(cost=", "(actual ", "(never executed)", "(rows="];
  let firstIdx = -1;
  for (const m of markers) {
    const idx = line.indexOf(m);
    if (idx >= 0 && (firstIdx < 0 || idx < firstIdx)) {
      firstIdx = idx;
    }
  }
  if (firstIdx >= 0) {
    return `${scrubSqlLiterals(line.slice(0, firstIdx))}${line.slice(firstIdx)}`;
  }
  const trimmed = line.trimStart();
  const colonIdx = trimmed.indexOf(": ");
  if (colonIdx > 0) {
    const key = trimmed.slice(0, colonIdx);
    if (/^[A-Za-z0-9 /\-]+$/.test(key)) {
      if (TEXT_MEASURE_KEYS.has(key.trim().toLowerCase())) {
        return line;
      }
      const indent = line.slice(0, line.length - trimmed.length);
      return `${indent}${key}: ${scrubSqlLiterals(trimmed.slice(colonIdx + 2))}`;
    }
  }
  return line.replace(/N?'(?:''|[^'])*'/g, "'?'");
}

function redactPostgresDeadlockLog(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const procStmt = line.match(/^([\s\S]*?\bProcess\s+\d+:\s+)(?!waits\s+for\b)([\s\S]*)$/);
      if (procStmt) {
        return `${procStmt[1]}${scrubSqlLiterals(procStmt[2]!)}`;
      }
      const stmtLine = line.match(/^([\s\S]*?\bSTATEMENT:\s*)([\s\S]*)$/);
      if (stmtLine) {
        return `${stmtLine[1]}${scrubSqlLiterals(stmtLine[2]!)}`;
      }
      return line;
    })
    .join("\n");
}

function redactInnodbDeadlockStatus(text: string): string {
  let inStatement = false;
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("*** ") || trimmed.startsWith("RECORD LOCKS ") || trimmed.startsWith("TABLE LOCK ")) {
        inStatement = false;
        return line;
      }
      if (trimmed.startsWith("MySQL thread id ") || trimmed.startsWith("MariaDB thread id ")) {
        inStatement = true;
        return line;
      }
      if (inStatement) {
        if (!trimmed) {
          inStatement = false;
          return line;
        }
        const indent = line.slice(0, line.length - line.trimStart().length);
        return `${indent}${scrubSqlLiterals(line.trimStart())}`;
      }
      return line.replace(/N?'(?:''|[^'])*'/g, "'?'");
    })
    .join("\n");
}

/**
 * Format-aware literal redaction for JSON plans, XML Showplan / deadlock reports, server deadlock logs,
 * and plain EXPLAIN text so redacted share payloads remain valid parseable inputs on explain.culpritsql.com.
 */
export function redactPayloadText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return JSON.stringify(redactJsonValue(parsed));
    } catch {
      return scrubSqlLiterals(text);
    }
  }

  if (trimmed.startsWith("<") || /<deadlock[\s>]/i.test(trimmed)) {
    return text
      .replace(
        /\b(ParameterCompiledValue|ParameterRuntimeValue|ConstValue|LowBoundary|HighBoundary)="([^"]*)"/g,
        '$1="?"',
      )
      .replace(
        /\b(StatementText|ScalarString|ParameterizedText|Expression)="([^"]*)"/g,
        (_m, attr: string, val: string) => `${attr}="${escapeXmlAttr(scrubSqlLiterals(unescapeXml(val)))}"`,
      )
      .replace(
        /<(inputbuf|frame\b[^>]*)>([\s\S]*?)<\/(inputbuf|frame)>/gi,
        (_m, openTag: string, body: string, closeTag: string) =>
          `<${openTag}>${escapeXmlText(scrubSqlLiterals(unescapeXml(body)))}</${closeTag}>`,
      );
  }

  if (trimmed.includes("LATEST DETECTED DEADLOCK") || trimmed.includes("*** (1) TRANSACTION")) {
    return redactInnodbDeadlockStatus(text);
  }

  if (trimmed.includes("deadlock detected")) {
    return redactPostgresDeadlockLog(text);
  }

  return text.split("\n").map(redactExplainTextLine).join("\n");
}

/**
 * Detects whether a document or pasted snippet represents a deadlock report or an execution plan.
 */
export function detectInputMode(content: string, fileName?: string): "deadlock" | "plan" {
  if (fileName && /\.xdl$/i.test(fileName.trim())) {
    return "deadlock";
  }
  if (
    /<deadlock(?:-list|s)?[\s>]/i.test(content) ||
    /\bdeadlock detected\b/i.test(content) ||
    /LATEST DETECTED DEADLOCK/i.test(content) ||
    /\bxml_deadlock_report\b/i.test(content)
  ) {
    return "deadlock";
  }
  return "plan";
}

/**
 * Encodes a SharePayloadV1 into `#s=z1.<deflate-raw-base64url>` matching explain.culpritsql.com.
 */
export async function encodeShareHash(
  payload: SharePayloadV1,
): Promise<{ ok: true; hash: string } | { ok: false; reason: "too_large" }> {
  const json = JSON.stringify(payload);
  const rawBytes = new TextEncoder().encode(json);
  const compressed = await compressDeflateRaw(rawBytes);
  const encoded = `z1.${toBase64Url(compressed)}`;
  if (encoded.length > MAX_HASH_CHARS) {
    return { ok: false, reason: "too_large" };
  }
  return { ok: true, hash: `#s=${encoded}` };
}

/**
 * Decodes a `#s=z1.<deflate-raw-base64url>` or full URL back into a SharePayloadV1.
 */
export async function decodeShareHash(hashOrUrl: string): Promise<SharePayloadV1 | null> {
  let fragment = hashOrUrl;
  const hashIdx = hashOrUrl.indexOf("#");
  if (hashIdx >= 0) {
    fragment = hashOrUrl.slice(hashIdx + 1);
  }
  const params = new URLSearchParams(fragment);
  const token = params.get("s");
  if (!token) return null;

  try {
    let bytes: Uint8Array;
    if (token.startsWith("z1.")) {
      bytes = await decompressDeflateRaw(fromBase64Url(token.slice(3)));
    } else if (token.startsWith("u1.")) {
      bytes = fromBase64Url(token.slice(3));
    } else {
      return null;
    }
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as SharePayloadV1;
    if (parsed?.v !== 1 || !parsed.m) return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface BuildShareUrlInput {
  mode: ShareStudioMode;
  title?: string;
  engine?: Engine;
  sql?: string;
  planText?: string;
  beforeName?: string;
  beforeText?: string;
  afterName?: string;
  afterText?: string;
  deadlockText?: string;
  redact?: boolean;
  baseUrl?: string;
}

/**
 * Builds a complete `https://explain.culpritsql.com/#s=z1.<deflate-raw-base64url>` link
 * with optional SQL literal redaction (enabled by default).
 */
export async function buildShareUrl(
  input: BuildShareUrlInput,
): Promise<{ ok: true; url: string; hash: string } | { ok: false; reason: "too_large" }> {
  const redact = input.redact ?? true;
  const baseUrl = (input.baseUrl ?? EXPLAIN_ONLINE_ORIGIN).replace(/\/+$/, "");

  let payload: SharePayloadV1;
  if (input.mode === "plan") {
    const p = redact ? redactPayloadText(input.planText ?? "") : (input.planText ?? "");
    const q = input.sql ? (redact ? scrubSqlLiterals(input.sql) : input.sql) : undefined;
    payload = {
      v: 1,
      m: "plan",
      t: input.title,
      e: input.engine,
      p,
      q,
    };
  } else if (input.mode === "compare") {
    const pa = redact ? redactPayloadText(input.beforeText ?? "") : (input.beforeText ?? "");
    const pb = redact ? redactPayloadText(input.afterText ?? "") : (input.afterText ?? "");
    const q = input.sql ? (redact ? scrubSqlLiterals(input.sql) : input.sql) : undefined;
    payload = {
      v: 1,
      m: "compare",
      e: input.engine,
      na: input.beforeName || "Before",
      pa,
      nb: input.afterName || "After",
      pb,
      q,
    };
  } else {
    const d = redact ? redactPayloadText(input.deadlockText ?? "") : (input.deadlockText ?? "");
    payload = {
      v: 1,
      m: "deadlock",
      t: input.title,
      d,
    };
  }

  const encoded = await encodeShareHash(payload);
  if (!encoded.ok) return encoded;
  return {
    ok: true,
    hash: encoded.hash,
    url: `${baseUrl}/${encoded.hash}`,
  };
}
