import {
  bindPlanViewerClipboard,
  DeadlockViewer,
  ExtendedEventsViewer,
  PlanDiffViewer,
  PlanViewer,
  type Deadlock,
  type Engine,
  type ExtendedEventsBatch,
  type Plan,
  type PlanDiff,
} from "@culpritsql/plan-viewer";
import "@culpritsql/plan-viewer/styles.css";
import {
  diffPlans,
  exportPlan,
  init as initPlansWasm,
  ParserError,
  parseDeadlock,
  parseExtendedEventsXml,
  parsePlan,
  parseXel,
} from "@culpritsql/plans";
import {
  Activity,
  AlertTriangle,
  ArrowLeftRight,
  ChevronDown,
  ChevronUp,
  Download,
  ExternalLink,
  FileCode2,
  FileText,
  FolderOpen,
  GitCompare,
  Lock,
  Play,
  ShieldCheck,
  Sparkles,
  Zap,
} from "lucide-react";
import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { FileSlot, HostToWebviewMessage, WebviewToHostMessage } from "../protocol";
import {
  buildShareUrl,
  decodeTextBytes,
  detectInputMode,
  encodeShareHash,
  EXPLAIN_ONLINE_ORIGIN,
  hasXelMagic,
  isExtendedEventsXml,
  scrubSqlLiterals,
  type SharePayloadV1,
} from "../shareLink";
import type { StudioMode, WebviewInitialState } from "../webviewHtml";
import { STUDIO_SAMPLES, type StudioSample } from "./samples";
import "./styles.css";

interface VsCodeWebviewApi<TState = unknown> {
  postMessage(message: WebviewToHostMessage): void;
  getState(): TState | undefined;
  setState(newState: TState): void;
}

declare function acquireVsCodeApi<TState = unknown>(): VsCodeWebviewApi<TState>;

const vscodeApi: VsCodeWebviewApi | null =
  typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;

type EngineChoice = "auto" | Engine;

type ActiveView =
  | { kind: "plan"; plan: Plan; title: string; rawText: string }
  | {
      kind: "compare";
      a: Plan;
      b: Plan;
      diff: PlanDiff;
      nameA: string;
      nameB: string;
      rawA: string;
      rawB: string;
    }
  | { kind: "deadlock"; deadlocks: Deadlock[]; index: number; title: string; rawText: string }
  | { kind: "events"; batch: ExtendedEventsBatch; title: string };

const ENGINE_OPTIONS: Array<{ value: EngineChoice; label: string }> = [
  { value: "auto", label: "Auto-detect engine" },
  { value: "postgres", label: "PostgreSQL" },
  { value: "mssql", label: "SQL Server" },
  { value: "mysql", label: "MySQL / MariaDB" },
  { value: "yugabyte", label: "YugabyteDB" },
  { value: "sqlite", label: "SQLite" },
];

function detectVsCodeBodyTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "dark";
  const cl = document.body.classList;
  if (cl.contains("vscode-light") || cl.contains("vscode-high-contrast-light")) {
    return "light";
  }
  return "dark";
}

function readInitialState(): WebviewInitialState {
  const el = document.getElementById("culprit-initial-state");
  if (el?.textContent) {
    try {
      return JSON.parse(el.textContent) as WebviewInitialState;
    } catch {
      // Fall back to empty studio state
    }
  }
  return {
    kind: "studio",
    mode: "plan",
    redactLiterals: true,
  };
}

let wasmReadyPromise: Promise<void> | null = null;

function ensureWasmLoaded(wasmUri: string): Promise<void> {
  if (!wasmReadyPromise) {
    wasmReadyPromise = initPlansWasm({ module_or_path: wasmUri }).catch((err) => {
      wasmReadyPromise = null;
      throw err;
    });
  }
  return wasmReadyPromise;
}

function slugifyFileName(title: string, ext: string): string {
  const clean = title
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return `${clean || "culprit-report"}.${ext}`;
}

function buildCompareMarkdown(
  view: Extract<ActiveView, { kind: "compare" }>,
  redact: boolean,
): string {
  const lines: string[] = [
    `# Execution Plan Comparison: ${view.nameA} vs ${view.nameB}`,
    "",
    ...view.diff.headlines.map((h) => `- **${h}**`),
    "",
    "## Structural & Cost Changes",
    "",
  ];
  if (view.diff.changes.length === 0) {
    lines.push("No major operator or access-path changes detected.");
  } else {
    for (const ch of view.diff.changes) {
      const detail = ch.detail ? ` (${redact ? scrubSqlLiterals(ch.detail) : ch.detail})` : "";
      lines.push(`- **[${ch.kind.toUpperCase()}]** ${ch.title}${detail}`);
    }
  }
  if (view.diff.scenarios.length > 0) {
    lines.push("", "## Root-Cause Scenarios", "");
    for (const sc of view.diff.scenarios) {
      lines.push(`- **${sc.title}**: ${sc.detail ?? ""}`);
    }
  }
  return lines.join("\n");
}

function buildDeadlockMarkdown(
  dl: Deadlock,
  title: string,
  redact: boolean,
): string {
  const lines: string[] = [
    `# Deadlock Report: ${title}`,
    "",
    `**Headline**: ${dl.headline}`,
    "",
    dl.explanation,
    "",
  ];
  if (dl.fixes.length > 0) {
    lines.push("## Recommended Fixes", "");
    for (const fix of dl.fixes) {
      lines.push(`1. **${fix.title}**: ${fix.detail}`);
      if (fix.sql) {
        lines.push("", "```sql", redact ? scrubSqlLiterals(fix.sql) : fix.sql, "```", "");
      }
    }
  }
  lines.push("## Involved Processes", "");
  for (const proc of dl.processes) {
    const badge = proc.victim ? " (Victim - Rolled Back)" : "";
    lines.push(`### Process ${proc.session ?? proc.id}${badge}`);
    if (proc.statement) {
      lines.push("```sql", redact ? scrubSqlLiterals(proc.statement) : proc.statement, "```", "");
    }
  }
  return lines.join("\n");
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function buildEventsMarkdown(batch: ExtendedEventsBatch, title: string): string {
  const lines: string[] = [
    `# SQL Server Extended Events: ${title}`,
    "",
    `- **Format**: ${batch.format.toUpperCase()}`,
    `- **Events parsed**: ${batch.records.length} (${batch.records_examined} examined)`,
    `- **Deadlock graphs**: ${batch.deadlocks.length}`,
    "",
    "## Events",
    "",
  ];
  for (const rec of batch.records) {
    const kindSummary =
      rec.kind.event === "error-reported"
        ? `ERROR ${rec.kind.number} (sev ${rec.kind.severity}, state ${rec.kind.state})`
        : rec.kind.event === "attention"
          ? `ATTENTION${rec.kind.native_duration ? ` (${rec.kind.native_duration})` : ""}`
          : `DEADLOCK (${rec.kind.graphs} graph${rec.kind.graphs === 1 ? "" : "s"})`;
    lines.push(
      `### #${rec.position + 1} [${kindSummary}]${rec.timestamp ? ` ${rec.timestamp}` : ""}`,
    );
    if (rec.statement.state === "available") {
      lines.push("", "```sql", rec.statement.text, "```");
    }
    lines.push("");
  }
  return lines.join("\n");
}

function wrapStandaloneHtml(title: string, markdownBody: string): string {
  const escaped = markdownBody
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const safeTitle = title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${safeTitle}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 920px; margin: 32px auto; padding: 0 20px; background: #141413; color: #ececea; line-height: 1.55; }
  pre { background: #1d1d1c; border: 1px solid #2c2c29; border-radius: 8px; padding: 16px; overflow-x: auto; white-space: pre-wrap; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; }
</style>
</head>
<body>
  <pre>${escaped}</pre>
</body>
</html>`;
}

function StudioApp({ wasmUri, iconUri, bootState }: { wasmUri: string; iconUri?: string; bootState: WebviewInitialState }) {
  const [theme, setTheme] = useState<"light" | "dark">(() => detectVsCodeBodyTheme());
  const [wasmReady, setWasmReady] = useState<boolean>(false);
  const [wasmError, setWasmError] = useState<string | null>(null);

  const [boundDocumentFile, setBoundDocumentFile] = useState<string | undefined>(
    bootState.kind === "document" ? bootState.fileName : undefined,
  );
  const [mode, setMode] = useState<StudioMode>(bootState.mode);
  const [engineChoice, setEngineChoice] = useState<EngineChoice>("auto");
  const [redact, setRedact] = useState<boolean>(bootState.redactLiterals);
  const [drawerOpen, setDrawerOpen] = useState<boolean>(
    bootState.kind === "studio" &&
      !bootState.text &&
      !bootState.xelBase64 &&
      !(bootState.beforeText && bootState.afterText),
  );

  const [title, setTitle] = useState<string>(bootState.title ?? "");
  const [planInput, setPlanInput] = useState<string>(bootState.mode === "plan" ? (bootState.text ?? "") : "");
  const [sqlInput, setSqlInput] = useState<string>(bootState.sql ?? "");
  const [beforeName, setBeforeName] = useState<string>(bootState.beforeName ?? "Before");
  const [beforeInput, setBeforeInput] = useState<string>(bootState.beforeText ?? "");
  const [afterName, setAfterName] = useState<string>(bootState.afterName ?? "After");
  const [afterInput, setAfterInput] = useState<string>(bootState.afterText ?? "");
  const [deadlockInput, setDeadlockInput] = useState<string>(
    bootState.mode === "deadlock" ? (bootState.text ?? "") : "",
  );
  const [eventsInput, setEventsInput] = useState<string>(
    bootState.mode === "events" ? (bootState.text ?? "") : "",
  );

  const [activeView, setActiveView] = useState<ActiveView | null>(null);
  const [parseError, setParseError] = useState<{ message: string; hint?: string | null } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  // Observe VS Code / Cursor / Windsurf body theme classes automatically
  useEffect(() => {
    setTheme(detectVsCodeBodyTheme());
    const observer = new MutationObserver(() => {
      setTheme(detectVsCodeBodyTheme());
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["class", "data-vscode-theme-kind"],
    });
    return () => observer.disconnect();
  }, []);

  // Wire @culpritsql/plan-viewer clipboard actions to VS Code host with navigator.clipboard fallback
  useEffect(() => {
    bindPlanViewerClipboard(async (text, label) => {
      if (vscodeApi) {
        vscodeApi.postMessage({ type: "copy", text, label });
        showToast(label ? `Copied ${label.toLowerCase()}` : "Copied to clipboard");
        return true;
      }
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        showToast(label ? `Copied ${label.toLowerCase()}` : "Copied to clipboard");
        return true;
      }
      return false;
    });
    return () => bindPlanViewerClipboard(null);
  }, [showToast]);

  const executeXelParse = useCallback(
    async (bytes: Uint8Array, opts?: { customTitle?: string; collapseDrawer?: boolean }) => {
      try {
        await ensureWasmLoaded(wasmUri);
        setWasmReady(true);
        setParseError(null);
        const batch = parseXel(bytes);
        const resolvedTitle =
          (opts?.customTitle ?? title).trim() || `Extended Events (${batch.records.length} events)`;
        setActiveView({ kind: "events", batch, title: resolvedTitle });
        if (opts?.collapseDrawer !== false) {
          setDrawerOpen(false);
        }
      } catch (err) {
        if (err instanceof ParserError) {
          setParseError({ message: err.error.message, hint: err.error.hint });
        } else {
          setParseError({ message: err instanceof Error ? err.message : "Failed to parse .xel file." });
        }
        setDrawerOpen(true);
      }
    },
    [title, wasmUri],
  );

  const executeEventsXmlParse = useCallback(
    async (raw: string, opts?: { customTitle?: string; collapseDrawer?: boolean }) => {
      const trimmed = raw.trim();
      if (!trimmed) {
        setParseError({
          message: "Load a binary .xel file or paste SQL Server Extended Events XML (<events> or <RingBufferTarget>).",
        });
        return;
      }
      try {
        await ensureWasmLoaded(wasmUri);
        setWasmReady(true);
        setParseError(null);
        const batch = parseExtendedEventsXml(trimmed);
        const resolvedTitle =
          (opts?.customTitle ?? title).trim() || `Extended Events (${batch.records.length} events)`;
        setActiveView({ kind: "events", batch, title: resolvedTitle });
        if (opts?.collapseDrawer !== false) {
          setDrawerOpen(false);
        }
      } catch (err) {
        if (err instanceof ParserError) {
          setParseError({ message: err.error.message, hint: err.error.hint });
        } else {
          setParseError({
            message: err instanceof Error ? err.message : "Failed to parse Extended Events XML.",
          });
        }
        setDrawerOpen(true);
      }
    },
    [title, wasmUri],
  );

  const executePlanParse = useCallback(
    async (raw: string, opts?: { customTitle?: string; sql?: string; engine?: EngineChoice; collapseDrawer?: boolean }) => {
      const trimmed = raw.trim();
      if (!trimmed) {
        setParseError({ message: "Paste an execution plan (.sqlplan XML, JSON, or EXPLAIN text) to visualize." });
        return;
      }
      if (isExtendedEventsXml(trimmed)) {
        setMode("events");
        setEventsInput(trimmed);
        await executeEventsXmlParse(trimmed, {
          customTitle: opts?.customTitle,
          collapseDrawer: opts?.collapseDrawer,
        });
        return;
      }
      try {
        await ensureWasmLoaded(wasmUri);
        setWasmReady(true);
        setParseError(null);
        const eng = opts?.engine ?? engineChoice;
        const parsed = parsePlan(trimmed, eng === "auto" ? undefined : eng);
        const query = (opts?.sql ?? sqlInput).trim();
        if (query && !parsed.statement) {
          parsed.statement = query;
        }
        const resolvedTitle = (opts?.customTitle ?? title).trim() || `${parsed.engine.toUpperCase()} Execution Plan`;
        setActiveView({ kind: "plan", plan: parsed, title: resolvedTitle, rawText: trimmed });
        if (opts?.collapseDrawer !== false) {
          setDrawerOpen(false);
        }
      } catch (err) {
        if (err instanceof ParserError) {
          setParseError({ message: err.error.message, hint: err.error.hint });
        } else {
          setParseError({ message: err instanceof Error ? err.message : "Failed to parse execution plan." });
        }
        setDrawerOpen(true);
      }
    },
    [engineChoice, executeEventsXmlParse, sqlInput, title, wasmUri],
  );

  const executeCompareParse = useCallback(
    async (
      rawA: string,
      rawB: string,
      opts?: { labelA?: string; labelB?: string; sql?: string; engine?: EngineChoice; collapseDrawer?: boolean },
    ) => {
      const trimA = rawA.trim();
      const trimB = rawB.trim();
      if (!trimA || !trimB) {
        setParseError({ message: "Provide both Before and After execution plans to compare side-by-side." });
        return;
      }
      try {
        await ensureWasmLoaded(wasmUri);
        setWasmReady(true);
        setParseError(null);
        const eng = opts?.engine ?? engineChoice;
        const hint = eng === "auto" ? undefined : eng;
        const planA = parsePlan(trimA, hint);
        const planB = parsePlan(trimB, hint);
        const query = (opts?.sql ?? sqlInput).trim();
        if (query) {
          if (!planA.statement) planA.statement = query;
          if (!planB.statement) planB.statement = query;
        }
        const resolvedA = (opts?.labelA ?? beforeName).trim() || "Before";
        const resolvedB = (opts?.labelB ?? afterName).trim() || "After";
        const diff = diffPlans(planA, resolvedA, planB, resolvedB);
        setActiveView({
          kind: "compare",
          a: planA,
          b: planB,
          diff,
          nameA: resolvedA,
          nameB: resolvedB,
          rawA: trimA,
          rawB: trimB,
        });
        if (opts?.collapseDrawer !== false) {
          setDrawerOpen(false);
        }
      } catch (err) {
        if (err instanceof ParserError) {
          setParseError({ message: err.error.message, hint: err.error.hint });
        } else {
          setParseError({ message: err instanceof Error ? err.message : "Failed to compare execution plans." });
        }
        setDrawerOpen(true);
      }
    },
    [afterName, beforeName, engineChoice, sqlInput, wasmUri],
  );

  const executeDeadlockParse = useCallback(
    async (raw: string, opts?: { customTitle?: string; collapseDrawer?: boolean }) => {
      const trimmed = raw.trim();
      if (!trimmed) {
        setParseError({
          message: "Paste a SQL Server <deadlock> XML graph, PostgreSQL deadlock log, or InnoDB status dump.",
        });
        return;
      }
      if (isExtendedEventsXml(trimmed)) {
        setMode("events");
        setEventsInput(trimmed);
        await executeEventsXmlParse(trimmed, opts);
        return;
      }
      try {
        await ensureWasmLoaded(wasmUri);
        setWasmReady(true);
        setParseError(null);
        const dls = parseDeadlock(trimmed);
        if (dls.length === 0) {
          setParseError({ message: "No deadlock wait cycle was found in this input." });
          setDrawerOpen(true);
          return;
        }
        const resolvedTitle =
          (opts?.customTitle ?? title).trim() || `Deadlock (${dls[0]!.processes.length} sessions)`;
        setActiveView({
          kind: "deadlock",
          deadlocks: dls,
          index: 0,
          title: resolvedTitle,
          rawText: trimmed,
        });
        if (opts?.collapseDrawer !== false) {
          setDrawerOpen(false);
        }
      } catch (err) {
        if (err instanceof ParserError) {
          setParseError({ message: err.error.message, hint: err.error.hint });
        } else {
          setParseError({ message: err instanceof Error ? err.message : "Failed to parse deadlock report." });
        }
        setDrawerOpen(true);
      }
    },
    [executeEventsXmlParse, title, wasmUri],
  );

  const applyIncomingState = useCallback(
    async (state: WebviewInitialState) => {
      setRedact(state.redactLiterals);
      setBoundDocumentFile(state.kind === "document" ? state.fileName : undefined);
      setMode(state.mode);
      setTitle(state.title ?? "");
      if (state.sql !== undefined) setSqlInput(state.sql);
      setParseError(null);

      if (state.xelBase64) {
        setMode("events");
        await executeXelParse(fromBase64(state.xelBase64), {
          customTitle: state.title,
          collapseDrawer: true,
        });
        return;
      }

      if (state.mode === "plan") {
        const text = state.text ?? "";
        setPlanInput(text);
        if (text.trim()) {
          await executePlanParse(text, {
            customTitle: state.title,
            sql: state.sql ?? "",
            collapseDrawer: true,
          });
        } else {
          setActiveView(null);
          setDrawerOpen(true);
        }
      } else if (state.mode === "compare") {
        const aName = state.beforeName ?? "Before";
        const bName = state.afterName ?? "After";
        const aText = state.beforeText ?? "";
        const bText = state.afterText ?? "";
        setBeforeName(aName);
        setBeforeInput(aText);
        setAfterName(bName);
        setAfterInput(bText);
        if (aText.trim() && bText.trim()) {
          await executeCompareParse(aText, bText, {
            labelA: aName,
            labelB: bName,
            sql: state.sql ?? "",
            collapseDrawer: true,
          });
        } else {
          setActiveView(null);
          setDrawerOpen(true);
        }
      } else if (state.mode === "events") {
        const eText = state.text ?? "";
        setEventsInput(eText);
        if (eText.trim()) {
          await executeEventsXmlParse(eText, {
            customTitle: state.title,
            collapseDrawer: true,
          });
        } else {
          setActiveView(null);
          setDrawerOpen(true);
        }
      } else if (state.mode === "deadlock") {
        const dText = state.text ?? "";
        setDeadlockInput(dText);
        if (dText.trim()) {
          await executeDeadlockParse(dText, {
            customTitle: state.title,
            collapseDrawer: true,
          });
        } else {
          setActiveView(null);
          setDrawerOpen(true);
        }
      }
    },
    [executeCompareParse, executeDeadlockParse, executeEventsXmlParse, executePlanParse, executeXelParse],
  );

  const handleShareOnline = useCallback(
    async (redactOverride?: boolean) => {
      const shouldRedact = redactOverride ?? redact;
      if (!activeView) {
        showToast("Visualize a plan, comparison, or deadlock first.");
        return;
      }

      try {
        await ensureWasmLoaded(wasmUri);
        let urlResult: { ok: true; url: string; hash: string } | { ok: false; reason: "too_large" };

        if (activeView.kind === "plan") {
          let planPayload = activeView.rawText;
          if (shouldRedact) {
            try {
              planPayload = exportPlan(activeView.plan, activeView.title, "native", {
                redact: true,
                notes: [],
              }).contents;
            } catch {
              // buildShareUrl applies format-aware fallback redaction below
            }
          }
          const payload: SharePayloadV1 = {
            v: 1,
            m: "plan",
            t: activeView.title,
            e: activeView.plan.engine,
            p: planPayload,
            q: activeView.plan.statement
              ? shouldRedact
                ? scrubSqlLiterals(activeView.plan.statement)
                : activeView.plan.statement
              : undefined,
          };
          const enc = await encodeShareHash(payload);
          urlResult = enc.ok
            ? { ok: true, hash: enc.hash, url: `${EXPLAIN_ONLINE_ORIGIN}/${enc.hash}` }
            : enc;
        } else if (activeView.kind === "compare") {
          let pa = activeView.rawA;
          let pb = activeView.rawB;
          if (shouldRedact) {
            try {
              pa = exportPlan(activeView.a, activeView.nameA, "native", { redact: true, notes: [] }).contents;
            } catch {
              // Fallback handled by buildShareUrl if needed
            }
            try {
              pb = exportPlan(activeView.b, activeView.nameB, "native", { redact: true, notes: [] }).contents;
            } catch {
              // Fallback handled by buildShareUrl if needed
            }
          }
          urlResult = await buildShareUrl({
            mode: "compare",
            beforeName: activeView.nameA,
            beforeText: pa,
            afterName: activeView.nameB,
            afterText: pb,
            redact: shouldRedact,
          });
        } else if (activeView.kind === "events") {
          urlResult = await buildShareUrl({
            mode: "events",
            title: activeView.title,
            eventsBatch: activeView.batch,
            redact: shouldRedact,
          });
        } else {
          urlResult = await buildShareUrl({
            mode: "deadlock",
            title: activeView.title,
            deadlockText: activeView.rawText,
            redact: shouldRedact,
          });
        }

        if (!urlResult.ok) {
          showToast("Payload exceeds URL limit. Use Export HTML instead.");
          return;
        }

        if (vscodeApi) {
          vscodeApi.postMessage({
            type: "openOnline",
            url: urlResult.url,
            copyToClipboard: true,
          });
          showToast(shouldRedact ? "Copied & opening redacted link..." : "Copied & opening share link...");
        } else if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(urlResult.url);
          showToast("Copied share link");
        }
      } catch {
        showToast("Could not build share link.");
      }
    },
    [activeView, redact, showToast, wasmUri],
  );

  // Boot Wasm and apply initial state on mount
  const bootedRef = useRef(false);
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    (async () => {
      try {
        await ensureWasmLoaded(wasmUri);
        setWasmReady(true);
        await applyIncomingState(bootState);
      } catch (err) {
        setWasmError(err instanceof Error ? err.message : "Failed to initialize @culpritsql/plans WebAssembly.");
      } finally {
        vscodeApi?.postMessage({ type: "ready" });
      }
    })();
  }, [applyIncomingState, bootState, wasmUri]);

  // Listen to host updates (live document streaming, command launches, file picker responses)
  useEffect(() => {
    const onMessage = (event: MessageEvent<HostToWebviewMessage>) => {
      const msg = event.data;
      if (!msg || typeof msg !== "object" || !("type" in msg)) return;

      if (msg.type === "loadState") {
        void applyIncomingState(msg.state);
      } else if (msg.type === "documentChanged") {
        setBoundDocumentFile(msg.fileName);
        const nextTitle = msg.fileName.replace(/\.[^.]+$/, "");
        setTitle(nextTitle);
        setMode(msg.mode);
        if (msg.mode === "events") {
          setEventsInput(msg.text);
          void executeEventsXmlParse(msg.text, { customTitle: nextTitle, collapseDrawer: true });
        } else if (msg.mode === "deadlock") {
          setDeadlockInput(msg.text);
          void executeDeadlockParse(msg.text, { customTitle: nextTitle, collapseDrawer: true });
        } else {
          setPlanInput(msg.text);
          void executePlanParse(msg.text, { customTitle: nextTitle, collapseDrawer: true });
        }
      } else if (msg.type === "filePicked") {
        const base = msg.name.replace(/\.[^.]+$/, "");
        if (msg.xelBase64) {
          setMode("events");
          setTitle(base);
          void executeXelParse(fromBase64(msg.xelBase64), { customTitle: base });
          return;
        }
        const pickedText = msg.text ?? "";
        if (msg.slot === "plan" || msg.slot === "events") {
          const detected = detectInputMode(pickedText, msg.name);
          if (detected === "events") {
            setMode("events");
            setEventsInput(pickedText);
            setTitle(base);
            void executeEventsXmlParse(pickedText, { customTitle: base });
          } else if (detected === "deadlock") {
            setMode("deadlock");
            setDeadlockInput(pickedText);
            setTitle(base);
            void executeDeadlockParse(pickedText, { customTitle: base });
          } else {
            setMode("plan");
            setPlanInput(pickedText);
            setTitle(base);
            void executePlanParse(pickedText, { customTitle: base });
          }
        } else if (msg.slot === "before") {
          setBeforeName(base || "Before");
          setBeforeInput(pickedText);
        } else if (msg.slot === "after") {
          setAfterName(base || "After");
          setAfterInput(pickedText);
        } else if (msg.slot === "deadlock") {
          if (detectInputMode(pickedText, msg.name) === "events") {
            setMode("events");
            setEventsInput(pickedText);
            setTitle(base);
            void executeEventsXmlParse(pickedText, { customTitle: base });
          } else {
            setDeadlockInput(pickedText);
            setTitle(base);
            void executeDeadlockParse(pickedText, { customTitle: base });
          }
        }
      } else if (msg.type === "requestShareOnline") {
        void handleShareOnline(msg.redact);
      }
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [applyIncomingState, executeDeadlockParse, executeEventsXmlParse, executePlanParse, executeXelParse, handleShareOnline]);

  const handleSwitchMode = (nextMode: StudioMode) => {
    setMode(nextMode);
    setParseError(null);
    vscodeApi?.postMessage({ type: "modeChanged", mode: nextMode });

    // Preload Before slot when switching from an active single Plan to Compare mode
    if (nextMode === "compare" && activeView?.kind === "plan" && !beforeInput.trim()) {
      setBeforeName(activeView.title || "Before");
      setBeforeInput(activeView.rawText);
    }

    const matchesActive =
      (nextMode === "plan" && activeView?.kind === "plan") ||
      (nextMode === "compare" && activeView?.kind === "compare") ||
      (nextMode === "deadlock" && activeView?.kind === "deadlock") ||
      (nextMode === "events" && activeView?.kind === "events");
    if (!matchesActive) {
      setDrawerOpen(true);
    }
  };

  const handleDropFile = useCallback(
    async (e: DragEvent<HTMLElement>) => {
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      e.preventDefault();
      const bytes = new Uint8Array(await file.arrayBuffer());
      const base = file.name.replace(/\.[^.]+$/, "");
      setTitle(base);
      if (/\.xel$/i.test(file.name) || hasXelMagic(bytes)) {
        setMode("events");
        await executeXelParse(bytes, { customTitle: base });
        return;
      }
      const text = decodeTextBytes(bytes);
      const detected = detectInputMode(text, file.name);
      if (detected === "events") {
        setMode("events");
        setEventsInput(text);
        await executeEventsXmlParse(text, { customTitle: base });
      } else if (detected === "deadlock") {
        setMode("deadlock");
        setDeadlockInput(text);
        await executeDeadlockParse(text, { customTitle: base });
      } else {
        setMode("plan");
        setPlanInput(text);
        await executePlanParse(text, { customTitle: base });
      }
    },
    [executeDeadlockParse, executeEventsXmlParse, executePlanParse, executeXelParse],
  );

  const handleExport = async (format: "html" | "markdown") => {
    if (!activeView) return;
    try {
      await ensureWasmLoaded(wasmUri);
      if (activeView.kind === "plan") {
        const exported = exportPlan(activeView.plan, activeView.title || "query-plan", format, {
          redact,
          notes: [],
        });
        vscodeApi?.postMessage({
          type: "exportFile",
          format,
          suggestedName: exported.name,
          contents: exported.contents,
        });
        return;
      }

      if (activeView.kind === "compare") {
        const md = buildCompareMarkdown(activeView, redact);
        const titleStr = `${activeView.nameA}-vs-${activeView.nameB}`;
        const contents = format === "html" ? wrapStandaloneHtml(titleStr, md) : md;
        vscodeApi?.postMessage({
          type: "exportFile",
          format,
          suggestedName: slugifyFileName(titleStr, format === "html" ? "html" : "md"),
          contents,
        });
        return;
      }

      if (activeView.kind === "events") {
        const md = buildEventsMarkdown(activeView.batch, activeView.title);
        const contents = format === "html" ? wrapStandaloneHtml(activeView.title, md) : md;
        vscodeApi?.postMessage({
          type: "exportFile",
          format,
          suggestedName: slugifyFileName(activeView.title, format === "html" ? "html" : "md"),
          contents,
        });
        return;
      }

      const currentDl = activeView.deadlocks[activeView.index] ?? activeView.deadlocks[0]!;
      const md = buildDeadlockMarkdown(currentDl, activeView.title, redact);
      const contents = format === "html" ? wrapStandaloneHtml(activeView.title, md) : md;
      vscodeApi?.postMessage({
        type: "exportFile",
        format,
        suggestedName: slugifyFileName(activeView.title, format === "html" ? "html" : "md"),
        contents,
      });
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not export report.");
    }
  };

  const handleLoadSample = async (sample: StudioSample) => {
    setParseError(null);
    setMode(sample.mode);
    if (sample.engine) setEngineChoice(sample.engine);
    if (sample.mode === "plan" && sample.planText) {
      setTitle(sample.label);
      setPlanInput(sample.planText);
      setSqlInput(sample.sql ?? "");
      await executePlanParse(sample.planText, {
        customTitle: sample.label,
        sql: sample.sql ?? "",
        engine: sample.engine ?? "auto",
      });
    } else if (sample.mode === "compare" && sample.beforeText && sample.afterText) {
      setBeforeName(sample.beforeName ?? "Before");
      setBeforeInput(sample.beforeText);
      setAfterName(sample.afterName ?? "After");
      setAfterInput(sample.afterText);
      await executeCompareParse(sample.beforeText, sample.afterText, {
        labelA: sample.beforeName ?? "Before",
        labelB: sample.afterName ?? "After",
        engine: sample.engine ?? "auto",
      });
    } else if (sample.mode === "deadlock" && sample.deadlockText) {
      setTitle(sample.label);
      setDeadlockInput(sample.deadlockText);
      await executeDeadlockParse(sample.deadlockText, { customTitle: sample.label });
    }
  };

  const requestHostFilePick = (slot: FileSlot) => {
    vscodeApi?.postMessage({ type: "pickFile", slot });
  };

  const currentDeadlock = useMemo(() => {
    if (activeView?.kind !== "deadlock") return null;
    return activeView.deadlocks[activeView.index] ?? activeView.deadlocks[0] ?? null;
  }, [activeView]);

  return (
    <div
      className={`vs-studio vs-theme-${theme}`}
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => void handleDropFile(e)}
    >
      <header className="vs-toolbar">
        <div className="vs-toolbar-left">
          <div className="vs-brand">
            {iconUri ? (
              <img src={iconUri} width={18} height={18} alt="" className="vs-brand-icon" />
            ) : (
              <Zap size={15} />
            )}
            <span className="vs-brand-name">Culprit</span>
          </div>

          {boundDocumentFile ? (
            <span className="vs-file-pill" title={boundDocumentFile}>
              <FileCode2 size={12} />
              <span>{boundDocumentFile}</span>
            </span>
          ) : (
            <span className={`vs-wasm-badge ${wasmError ? "err" : wasmReady ? "ok" : "wait"}`}>
              <ShieldCheck size={12} />
              <span>{wasmError ? "Wasm Error" : wasmReady ? "Local Wasm" : "Loading Wasm"}</span>
            </span>
          )}

          <div className="vs-mode-seg" role="tablist" aria-label="Studio Mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "plan"}
              className={mode === "plan" ? "on" : ""}
              onClick={() => handleSwitchMode("plan")}
            >
              <Zap size={12} /> Plan
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "compare"}
              className={mode === "compare" ? "on" : ""}
              onClick={() => handleSwitchMode("compare")}
            >
              <GitCompare size={12} /> Compare
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "deadlock"}
              className={mode === "deadlock" ? "on" : ""}
              onClick={() => handleSwitchMode("deadlock")}
            >
              <Lock size={12} /> Deadlock
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "events"}
              className={mode === "events" ? "on" : ""}
              onClick={() => handleSwitchMode("events")}
            >
              <Activity size={12} /> Events
            </button>
          </div>

          <button
            type="button"
            className={`vs-btn vs-btn-ghost ${drawerOpen ? "active" : ""}`}
            onClick={() => setDrawerOpen((v) => !v)}
            title="Toggle EXPLAIN / Deadlock paste input drawer"
          >
            {drawerOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            <span>{boundDocumentFile ? "Input" : "Paste Input"}</span>
          </button>
        </div>

        <div className="vs-toolbar-right">
          <label className="vs-redact-toggle" title="Scrub SQL string and numeric literals in exports and share links">
            <input
              type="checkbox"
              checked={redact}
              onChange={(e) => setRedact(e.target.checked)}
            />
            <span>Redact literals</span>
          </label>

          <button
            type="button"
            className="vs-btn vs-btn-ghost"
            disabled={!activeView}
            onClick={() => void handleExport("html")}
            title="Save standalone interactive HTML report"
          >
            <Download size={13} />
            <span>Export HTML</span>
          </button>

          <button
            type="button"
            className="vs-btn vs-btn-ghost"
            disabled={!activeView}
            onClick={() => void handleExport("markdown")}
            title="Save Markdown summary report"
          >
            <FileText size={13} />
            <span>Export MD</span>
          </button>

          <button
            type="button"
            className="vs-btn vs-btn-accent"
            disabled={!activeView}
            onClick={() => void handleShareOnline()}
            title="Copy & open compressed client-side link on explain.culpritsql.com"
          >
            <ExternalLink size={13} />
            <span>Share Redacted Link</span>
          </button>
        </div>
      </header>

      {wasmError && (
        <div className="vs-error-banner" role="alert">
          <AlertTriangle size={15} />
          <div>
            <strong>WebAssembly initialization failed:</strong> {wasmError}
          </div>
        </div>
      )}

      {parseError && (
        <div className="vs-error-banner" role="alert">
          <AlertTriangle size={15} />
          <div>
            <strong>{parseError.message}</strong>
            {parseError.hint && <div className="vs-error-hint">{parseError.hint}</div>}
          </div>
        </div>
      )}

      {drawerOpen && (
        <section className="vs-drawer" aria-label="Plan and Deadlock Input Drawer">
          <div className="vs-drawer-bar">
            <div className="vs-samples-row">
              <span className="vs-samples-label">
                <Sparkles size={12} /> Try sample:
              </span>
              {STUDIO_SAMPLES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="vs-sample-chip"
                  onClick={() => void handleLoadSample(s)}
                >
                  <span className="vs-sample-badge">{s.badge}</span>
                  <span>{s.label}</span>
                </button>
              ))}
            </div>

            {mode !== "deadlock" && mode !== "events" && (
              <select
                className="vs-select"
                value={engineChoice}
                onChange={(e) => setEngineChoice(e.target.value as EngineChoice)}
                aria-label="SQL Engine Hint"
              >
                {ENGINE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            )}
          </div>

          {mode === "plan" && (
            <div className="vs-input-stack">
              <div className="vs-field-head">
                <label htmlFor="vs-plan-textarea">
                  Execution Plan (PostgreSQL JSON or text, SQL Server .sqlplan XML, MySQL JSON or ANALYZE, YugabyteDB, SQLite)
                </label>
                <button
                  type="button"
                  className="vs-btn vs-btn-ghost vs-btn-sm"
                  onClick={() => requestHostFilePick("plan")}
                >
                  <FolderOpen size={12} /> Load File...
                </button>
              </div>
              <textarea
                id="vs-plan-textarea"
                className="vs-textarea"
                rows={7}
                value={planInput}
                onChange={(e) => setPlanInput(e.target.value)}
                placeholder="Paste EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON), <ShowPlanXML ...>, EXPLAIN FORMAT=JSON, or EXPLAIN QUERY PLAN output..."
              />
              <div className="vs-sql-row">
                <input
                  type="text"
                  className="vs-input"
                  value={sqlInput}
                  onChange={(e) => setSqlInput(e.target.value)}
                  placeholder="Optional SQL query text (attached to the plan diagram if not embedded in plan output)"
                />
                <button
                  type="button"
                  className="vs-btn vs-btn-primary"
                  onClick={() => void executePlanParse(planInput)}
                >
                  <Play size={13} /> Visualize Plan
                </button>
              </div>
            </div>
          )}

          {mode === "compare" && (
            <div className="vs-input-stack">
              <div className="vs-compare-grid">
                <div className="vs-compare-col">
                  <div className="vs-field-head">
                    <input
                      type="text"
                      className="vs-input vs-input-inline"
                      value={beforeName}
                      onChange={(e) => setBeforeName(e.target.value)}
                      aria-label="Before plan name"
                    />
                    <button
                      type="button"
                      className="vs-btn vs-btn-ghost vs-btn-sm"
                      onClick={() => requestHostFilePick("before")}
                    >
                      <FolderOpen size={12} /> Load Before...
                    </button>
                  </div>
                  <textarea
                    className="vs-textarea"
                    rows={6}
                    value={beforeInput}
                    onChange={(e) => setBeforeInput(e.target.value)}
                    placeholder="Paste baseline (Before) execution plan..."
                  />
                </div>

                <div className="vs-compare-col">
                  <div className="vs-field-head">
                    <input
                      type="text"
                      className="vs-input vs-input-inline"
                      value={afterName}
                      onChange={(e) => setAfterName(e.target.value)}
                      aria-label="After plan name"
                    />
                    <button
                      type="button"
                      className="vs-btn vs-btn-ghost vs-btn-sm"
                      onClick={() => requestHostFilePick("after")}
                    >
                      <FolderOpen size={12} /> Load After...
                    </button>
                  </div>
                  <textarea
                    className="vs-textarea"
                    rows={6}
                    value={afterInput}
                    onChange={(e) => setAfterInput(e.target.value)}
                    placeholder="Paste candidate (After) execution plan..."
                  />
                </div>
              </div>

              <div className="vs-sql-row">
                <button
                  type="button"
                  className="vs-btn vs-btn-ghost"
                  onClick={() => {
                    setBeforeName(afterName);
                    setAfterName(beforeName);
                    setBeforeInput(afterInput);
                    setAfterInput(beforeInput);
                  }}
                >
                  <ArrowLeftRight size={13} /> Swap A / B
                </button>
                <span className="vs-spacer" />
                <button
                  type="button"
                  className="vs-btn vs-btn-primary"
                  onClick={() => void executeCompareParse(beforeInput, afterInput)}
                >
                  <GitCompare size={13} /> Compare Plans
                </button>
              </div>
            </div>
          )}

          {mode === "deadlock" && (
            <div className="vs-input-stack">
              <div className="vs-field-head">
                <label htmlFor="vs-deadlock-textarea">
                  Deadlock Graph or Log (SQL Server .xdl / XML, PostgreSQL server log, or MySQL SHOW ENGINE INNODB STATUS)
                </label>
                <button
                  type="button"
                  className="vs-btn vs-btn-ghost vs-btn-sm"
                  onClick={() => requestHostFilePick("deadlock")}
                >
                  <FolderOpen size={12} /> Load File...
                </button>
              </div>
              <textarea
                id="vs-deadlock-textarea"
                className="vs-textarea"
                rows={7}
                value={deadlockInput}
                onChange={(e) => setDeadlockInput(e.target.value)}
                placeholder="Paste <deadlock> XML, PostgreSQL ERROR: deadlock detected + DETAIL, or InnoDB LATEST DETECTED DEADLOCK..."
              />
              <div className="vs-sql-row">
                <span className="vs-spacer" />
                <button
                  type="button"
                  className="vs-btn vs-btn-primary"
                  onClick={() => void executeDeadlockParse(deadlockInput)}
                >
                  <Play size={13} /> Analyze Deadlock
                </button>
              </div>
            </div>
          )}

          {mode === "events" && (
            <div className="vs-input-stack">
              <div className="vs-field-head">
                <label htmlFor="vs-events-textarea">
                  SQL Server Extended Events (drop or load a binary .xel file, or paste &lt;events&gt; / &lt;RingBufferTarget&gt; XML)
                </label>
                <button
                  type="button"
                  className="vs-btn vs-btn-ghost vs-btn-sm"
                  onClick={() => requestHostFilePick("events")}
                >
                  <FolderOpen size={12} /> Load .xel / XML...
                </button>
              </div>
              <textarea
                id="vs-events-textarea"
                className="vs-textarea"
                rows={7}
                value={eventsInput}
                onChange={(e) => setEventsInput(e.target.value)}
                placeholder="Paste exported SQL Server Extended Events XML (<events> or <RingBufferTarget>), or click Load .xel / XML to inspect a binary .xel capture..."
              />
              <div className="vs-sql-row">
                <span className="vs-spacer" />
                <button
                  type="button"
                  className="vs-btn vs-btn-primary"
                  onClick={() => void executeEventsXmlParse(eventsInput)}
                >
                  <Play size={13} /> Inspect Events
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      <main className="vs-canvas">
        {activeView?.kind === "plan" && mode === "plan" && (
          <PlanViewer
            plan={activeView.plan}
            title={activeView.title}
            theme={theme}
          />
        )}

        {activeView?.kind === "compare" && mode === "compare" && (
          <PlanDiffViewer
            a={activeView.a}
            b={activeView.b}
            diff={activeView.diff}
            nameA={activeView.nameA}
            nameB={activeView.nameB}
            theme={theme}
          />
        )}

        {activeView?.kind === "deadlock" && mode === "deadlock" && currentDeadlock && (
          <div className="vs-deadlock-wrap">
            {activeView.deadlocks.length > 1 && (
              <div className="vs-cycle-bar">
                <span>Deadlock cycle:</span>
                {activeView.deadlocks.map((_, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className={`vs-sample-chip ${activeView.index === idx ? "on" : ""}`}
                    onClick={() => setActiveView({ ...activeView, index: idx })}
                  >
                    Cycle {idx + 1}
                  </button>
                ))}
              </div>
            )}
            <DeadlockViewer deadlock={currentDeadlock} theme={theme} />
          </div>
        )}

        {activeView?.kind === "events" && mode === "events" && (
          <ExtendedEventsViewer batch={activeView.batch} theme={theme} />
        )}

        {(!activeView ||
          (mode === "plan" && activeView.kind !== "plan") ||
          (mode === "compare" && activeView.kind !== "compare") ||
          (mode === "deadlock" && activeView.kind !== "deadlock") ||
          (mode === "events" && activeView.kind !== "events")) && (
          <div className="vs-empty-hint">
            <p>
              Runs 100% locally in WebAssembly. Zero database credentials or network uploads required.
            </p>
          </div>
        )}
      </main>

      {toast && (
        <div className="vs-toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  const wasmUri = rootEl.dataset.wasmUri ?? "culprit_wasm_bg.wasm";
  const iconUri = rootEl.dataset.iconUri;
  const bootState = readInitialState();
  createRoot(rootEl).render(<StudioApp wasmUri={wasmUri} iconUri={iconUri} bootState={bootState} />);
}
