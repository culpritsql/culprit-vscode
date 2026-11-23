import { randomBytes } from "node:crypto";

export type StudioMode = "plan" | "compare" | "deadlock";

export interface WebviewInitialState {
  kind: "document" | "studio";
  mode: StudioMode;
  title?: string;
  fileName?: string;
  text?: string;
  sql?: string;
  beforeName?: string;
  beforeText?: string;
  afterName?: string;
  afterText?: string;
  redactLiterals: boolean;
}

export interface WebviewHtmlOptions {
  cspSource: string;
  scriptUri: string;
  styleUri: string;
  wasmUri: string;
  iconUri?: string;
  title?: string;
  nonce?: string;
  initialState: WebviewInitialState;
}

const NONCE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Generates a cryptographically strong CSP nonce safe for script-src attributes.
 */
export function createNonce(length = 32): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += NONCE_ALPHABET[bytes[i]! % NONCE_ALPHABET.length];
  }
  return out;
}

/**
 * Builds the strict Content-Security-Policy string for the VS Code Webview.
 * Allows WebAssembly instantiation via 'wasm-unsafe-eval' and restricts scripts to the per-render nonce.
 */
export function buildWebviewCsp(cspSource: string, nonce: string): string {
  return `default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' 'wasm-unsafe-eval'; connect-src ${cspSource};`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Serializes state safely for embedding inside a <script type="application/json"> tag
 * so closing tags or HTML characters inside SQL / XML plans can never break out of the container.
 */
export function serializeJsonForHtml(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Builds the pure HTML document rendered inside CustomTextEditorProvider and Studio WebviewPanels.
 */
export function buildWebviewHtml(options: WebviewHtmlOptions): string {
  const nonce = options.nonce ?? createNonce(32);
  const csp = buildWebviewCsp(options.cspSource, nonce);
  const title = escapeHtml(options.title ?? "Culprit SQL Studio");
  const wasmUri = escapeHtml(options.wasmUri);
  const styleUri = escapeHtml(options.styleUri);
  const scriptUri = escapeHtml(options.scriptUri);
  const iconAttr = options.iconUri ? ` data-icon-uri="${escapeHtml(options.iconUri)}"` : "";
  const stateJson = serializeJsonForHtml(options.initialState);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <link rel="stylesheet" href="${styleUri}" />
</head>
<body>
  <div id="root" data-wasm-uri="${wasmUri}"${iconAttr}></div>
  <script id="culprit-initial-state" type="application/json" nonce="${nonce}">${stateJson}</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
