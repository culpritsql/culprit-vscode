import { describe, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  diffPlans,
  init as initWasm,
  parseDeadlock,
  parseExtendedEventsXml,
  parsePlan,
  parseXel,
} from "@culpritsql/plans";
import {
  buildShareUrl,
  decodeShareHash,
  detectInputMode,
  EXPLAIN_ONLINE_ORIGIN,
  hasXelMagic,
  redactPayloadText,
  scrubSqlLiterals,
} from "../src/shareLink";
import { extractSqlBlocks, inspectSqlDocument } from "../src/sqlInspector";
import { STUDIO_SAMPLES } from "../src/webview/samples";
import { buildWebviewCsp, buildWebviewHtml, createNonce } from "../src/webviewHtml";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..");

describe("sqlInspector: SQL files and TypeScript tagged templates", () => {
  test("extracts multi-statement .sql blocks with exact 0-based line/character ranges and ignores semicolons in strings/comments", () => {
    const sqlDoc = [
      "-- Migration header comment; not a statement",
      "SELECT id, 'semi;colon' AS note",
      "FROM public.orders",
      "WHERE status = 'paid';",
      "",
      "/* Block comment; ignored */",
      "UPDATE public.customers SET tier = 'gold' WHERE id = 42;",
    ].join("\n");

    const blocks = extractSqlBlocks(sqlDoc, "sql", "queries.sql");
    expect(blocks).toHaveLength(2);

    expect(blocks[0]!.category).toBe("query");
    expect(blocks[0]!.label).toBe("SELECT orders");
    expect(blocks[0]!.range).toEqual({
      start: { line: 1, character: 0 },
      end: { line: 3, character: 22 },
    });

    expect(blocks[1]!.category).toBe("query");
    expect(blocks[1]!.label).toBe("UPDATE customers");
    expect(blocks[1]!.range).toEqual({
      start: { line: 6, character: 0 },
      end: { line: 6, character: 56 },
    });
  });

  test("extracts sql`...` and Prisma.$queryRaw<T>`...` tagged templates with exact ranges and ignores plain JS strings/comments", () => {
    const tsDoc = [
      "import { Prisma } from '@prisma/client';",
      "// sql`DELETE FROM ignored_in_comment`",
      "const note = `SELECT * FROM untagged_template`;",
      "const rows = await sql`SELECT id, email FROM users WHERE id = ${userId}`;",
      "const orders = await Prisma.$queryRaw<Order[]>`",
      "  SELECT o.id, o.total_cents",
      "  FROM orders o",
      "  WHERE LOWER(o.email) = ${email.toLowerCase()}",
      "`;",
    ].join("\n");

    const blocks = extractSqlBlocks(tsDoc, "typescript", "repo.ts");
    expect(blocks).toHaveLength(2);

    expect(blocks[0]!.source).toBe("tagged-template");
    expect(blocks[0]!.tag).toBe("sql");
    expect(blocks[0]!.range).toEqual({
      start: { line: 3, character: 23 },
      end: { line: 3, character: 71 },
    });

    expect(blocks[1]!.source).toBe("tagged-template");
    expect(blocks[1]!.tag).toBe("Prisma.$queryRaw");
    expect(blocks[1]!.range.start).toEqual({ line: 5, character: 2 });
    expect(blocks[1]!.range.end).toEqual({ line: 7, character: 47 });

    const diags = inspectSqlDocument(tsDoc, "typescript", "repo.ts");
    expect(diags).toHaveLength(1);
    expect(diags[0]!.code).toBe("culprit-non-sargable-predicate");
    // "  WHERE LOWER(o.email) = ..." -> line 7, "LOWER(o.email)" is columns 8..22
    expect(diags[0]!.range).toEqual({
      start: { line: 7, character: 8 },
      end: { line: 7, character: 22 },
    });
  });

  test("flags UPDATE and DELETE without WHERE while allowing WHERE, FOR UPDATE, and ON DELETE CASCADE", () => {
    const sql = [
      "CREATE TABLE items (",
      "  id bigint PRIMARY KEY,",
      "  order_id bigint REFERENCES orders(id) ON DELETE CASCADE ON UPDATE RESTRICT",
      ");",
      "SELECT * FROM orders WHERE id = 10 FOR UPDATE;",
      "UPDATE accounts SET active = false;",
      "DELETE FROM sessions;",
      "UPDATE accounts SET active = true WHERE id = 7;",
      "DELETE FROM sessions WHERE expires_at < now();",
    ].join("\n");

    const diags = inspectSqlDocument(sql, "sql", "mutations.sql");
    expect(diags).toHaveLength(2);
    expect(diags[0]!.code).toBe("culprit-unbounded-mutation");
    expect(diags[0]!.range.start.line).toBe(5);
    expect(diags[1]!.code).toBe("culprit-unbounded-mutation");
    expect(diags[1]!.range.start.line).toBe(6);
  });

  test("flags CREATE INDEX without CONCURRENTLY on existing tables, skips tables created in same file, and errors on CONCURRENTLY inside BEGIN...COMMIT", () => {
    const migrationSql = [
      "CREATE TABLE audit_events (id bigserial PRIMARY KEY, actor_id bigint);",
      "CREATE INDEX ix_audit_events_actor ON audit_events (actor_id);",
      "CREATE INDEX ix_orders_customer ON public.orders (customer_id);",
      "BEGIN;",
      "CREATE UNIQUE INDEX CONCURRENTLY ix_users_email_uniq ON users (email);",
      "COMMIT;",
      "CREATE INDEX CONCURRENTLY ix_orders_paid ON orders (created_at);",
    ].join("\n");

    const diags = inspectSqlDocument(migrationSql, "sql", "002_indexes.sql");
    expect(diags).toHaveLength(2);

    // Existing table `orders` without CONCURRENTLY (line 2)
    expect(diags[0]!.code).toBe("culprit-index-not-concurrent");
    expect(diags[0]!.severity).toBe("warning");
    expect(diags[0]!.range.start.line).toBe(2);

    // CONCURRENTLY inside BEGIN...COMMIT (line 4)
    expect(diags[1]!.code).toBe("culprit-concurrent-index-in-tx");
    expect(diags[1]!.severity).toBe("error");
    expect(diags[1]!.range.start.line).toBe(4);
  });

  test("flags leading-wildcard LIKE/ILIKE and ignores prefix LIKE or wildcards inside comments and plain strings", () => {
    const sql = [
      "-- SELECT * FROM users WHERE name LIKE '%commented_out%';",
      "SELECT * FROM users WHERE note = '100% legit' AND handle LIKE 'cris%';",
      "SELECT * FROM users WHERE email ILIKE '%@corp.example';",
    ].join("\n");

    const diags = inspectSqlDocument(sql, "sql", "search.sql");
    expect(diags).toHaveLength(1);
    expect(diags[0]!.code).toBe("culprit-leading-wildcard-like");
    expect(diags[0]!.range.start).toEqual({ line: 2, character: 32 });
  });
});

describe("webviewHtml: CSP, nonces, and safe initial state serialization", () => {
  test("generates cryptographic alphanumeric nonces and strict WebAssembly CSP", () => {
    const n1 = createNonce();
    const n2 = createNonce();
    expect(n1).toHaveLength(32);
    expect(n1).toMatch(/^[A-Za-z0-9]+$/);
    expect(n1).not.toBe(n2);

    const csp = buildWebviewCsp("vscode-webview://panel-1", n1);
    expect(csp).toBe(
      `default-src 'none'; img-src vscode-webview://panel-1 data:; style-src vscode-webview://panel-1 'unsafe-inline'; script-src 'nonce-${n1}' 'wasm-unsafe-eval'; connect-src vscode-webview://panel-1;`,
    );
  });

  test("embeds data-wasm-uri and neutralizes script-breakout sequences inside initialState", () => {
    const html = buildWebviewHtml({
      cspSource: "vscode-webview://abc",
      scriptUri: "https://file+.vscode-resource.vscode-cdn.net/dist/webview.js",
      styleUri: "https://file+.vscode-resource.vscode-cdn.net/dist/webview.css",
      wasmUri: "https://file+.vscode-resource.vscode-cdn.net/dist/culprit_wasm_bg.wasm",
      nonce: "FixedTestNonce1234567890",
      title: "Plan <Test>",
      initialState: {
        kind: "document",
        mode: "plan",
        fileName: "evil.sqlplan",
        text: "</script><script>window.pwned = true;</script>",
        redactLiterals: true,
      },
    });

    expect(html).toContain('data-wasm-uri="https://file+.vscode-resource.vscode-cdn.net/dist/culprit_wasm_bg.wasm"');
    expect(html).toContain('nonce="FixedTestNonce1234567890"');
    expect(html).toContain("<title>Plan &lt;Test&gt;</title>");
    expect(html).not.toContain("</script><script>window.pwned");
    expect(html).toContain("\\u003c/script\\u003e");
  });
});

describe("shareLink & detectInputMode: z1 deflate-raw links and SQL literal redaction", () => {
  test("detects deadlock reports and Extended Events across SQL Server XML/.xel, PostgreSQL logs, and InnoDB status", () => {
    expect(detectInputMode("<ShowPlanXML></ShowPlanXML>", "query.sqlplan")).toBe("plan");
    expect(detectInputMode("", "system_health_0.xel")).toBe("events");
    expect(
      detectInputMode(
        '<RingBufferTarget><event name="error_reported" package="sqlserver"/></RingBufferTarget>',
        "capture.xml",
      ),
    ).toBe("events");
    expect(detectInputMode("<deadlock><victim-list/></deadlock>", "capture.xml")).toBe("deadlock");
    expect(detectInputMode("{}", "incident.xdl")).toBe("deadlock");
    expect(detectInputMode("ERROR:  deadlock detected\nDETAIL: Process 101 waits", "pg.log")).toBe("deadlock");
    expect(detectInputMode("------------------------\nLATEST DETECTED DEADLOCK\n------------------------")).toBe("deadlock");
    expect(hasXelMagic(new Uint8Array([0x5a, 0x37, 0xab, 0xef, 0x03, 0x00]))).toBe(true);
    expect(hasXelMagic(new Uint8Array([0x3c, 0x65, 0x76, 0x65]))).toBe(false);
  });

  test("encodes z1.<deflate-raw-base64url> share URLs with scrubbed SQL literals while keeping JSON plans valid", async () => {
    const rawPlan = STUDIO_SAMPLES[0]!.planText!;
    const rawSql = "SELECT * FROM orders WHERE customer_email = 'ceo@acme.io' AND total_cents > 95000 AND active = 1;";

    const share = await buildShareUrl({
      mode: "plan",
      title: "Checkout Spill",
      engine: "postgres",
      planText: rawPlan,
      sql: rawSql,
      redact: true,
    });

    expect(share.ok).toBe(true);
    if (!share.ok) return;

    expect(share.url.startsWith(`${EXPLAIN_ONLINE_ORIGIN}/#s=z1.`)).toBe(true);
    expect(share.url).not.toContain("ceo@acme.io");
    expect(share.url).not.toContain("2026-10-01");

    const decoded = await decodeShareHash(share.url);
    expect(decoded).not.toBeNull();
    expect(decoded?.v).toBe(1);
    expect(decoded?.m).toBe("plan");
    expect(decoded?.q).toContain("customer_email = '?'");
    expect(decoded?.q).toContain("total_cents > ?");
    expect(decoded?.q).toContain("active = 1");

    // Redacted JSON plan must still parse cleanly as valid JSON with intact execution metrics!
    const parsedJson = JSON.parse(decoded!.p!);
    expect(parsedJson[0].Plan["Actual Rows"]).toBe(50);
    expect(parsedJson[0].Plan.Plans[0].Plans[0].Filter).toContain("'?'");
    expect(parsedJson[0].Plan.Plans[0].Plans[0].Filter).not.toContain("paid");
  });

  test("redacts SQL Server Showplan XML parameter values without corrupting XML numeric attributes", () => {
    const xml = `<ShowPlanXML StatementText="SELECT * FROM users WHERE email = 'secret@corp.io' AND age = 44"><ColumnReference ParameterCompiledValue="'secret@corp.io'" ConstValue="(99812)" EstimateRows="250"/></ShowPlanXML>`;
    const redacted = redactPayloadText(xml);
    expect(redacted).not.toContain("secret@corp.io");
    expect(redacted).not.toContain("99812");
    expect(redacted).toContain('EstimateRows="250"');
    expect(scrubSqlLiterals("WHERE code = 'AB''CD' AND retries = 5 AND id = $2")).toBe(
      "WHERE code = '?' AND retries = ? AND id = $2",
    );
  });

  test("round-trips multi-chunk payloads without Web Streams CompressionStream backpressure deadlock", async () => {
    const bigPlan = JSON.stringify(
      Array.from({ length: 350 }, (_, i) => ({
        op: `Partition_${i}`,
        Filter: `(org_id = ${5000 + i} AND secret = 'tok_${i}')`,
      })),
    );
    const share = await buildShareUrl({
      mode: "plan",
      title: "Partitioned Plan",
      engine: "postgres",
      planText: bigPlan,
      redact: true,
    });
    expect(share.ok).toBe(true);
    if (!share.ok) return;
    expect(share.url).not.toContain("tok_0");
    const decoded = await decodeShareHash(share.url);
    expect(decoded?.t).toBe("Partitioned Plan");
    expect(JSON.parse(decoded!.p!).length).toBe(350);
  });
});

describe("Build artifacts, Wasm engine integration, and mocked VS Code extension host", () => {
  test("validates package.json manifest, builds dist bundles, runs Wasm parser, and activates extension cleanly", async () => {
    const pkgJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    expect(pkgJson.name).toBe("culprit-sql");
    expect(pkgJson.publisher).toBe("culpritsql");
    expect(pkgJson.displayName).toBe("Culprit SQL");
    expect(pkgJson.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(existsSync(path.join(repoRoot, "media/icon.svg"))).toBe(true);
    expect(existsSync(path.join(repoRoot, "media/icon.png"))).toBe(true);

    const cmdIds = pkgJson.contributes.commands.map((c: { command: string }) => c.command);
    expect(cmdIds).toEqual([
      "culprit.openExplainStudio",
      "culprit.explainClipboard",
      "culprit.explainSelection",
      "culprit.comparePlans",
      "culprit.openOnline",
    ]);

    // Ensure build script produces all four dist artifacts
    execFileSync("node", ["scripts/build.mjs"], { cwd: repoRoot, stdio: "pipe" });

    for (const file of ["extension.js", "webview.js", "webview.css", "culprit_wasm_bg.wasm"]) {
      const target = path.join(repoRoot, "dist", file);
      expect(existsSync(target)).toBe(true);
      expect(statSync(target).size).toBeGreaterThan(500);
    }

    const cssText = readFileSync(path.join(repoRoot, "dist/webview.css"), "utf8");
    expect(cssText).toContain(".culprit-pv");
    expect(cssText).toContain(".vs-studio");

    // Verify @culpritsql/plans Wasm binary copied into dist/ parses real plans, diffs, and deadlocks
    const wasmBytes = readFileSync(path.join(repoRoot, "dist/culprit_wasm_bg.wasm"));
    await initWasm({ module_or_path: wasmBytes });
    const planA = parsePlan(STUDIO_SAMPLES[1]!.beforeText!, "postgres");
    const planB = parsePlan(STUDIO_SAMPLES[1]!.afterText!, "postgres");
    const diff = diffPlans(planA, "Before", planB, "After");
    expect(planA.engine).toBe("postgres");
    expect(diff.changes.length).toBeGreaterThan(0);

    const deadlocks = parseDeadlock(STUDIO_SAMPLES[2]!.deadlockText!);
    expect(deadlocks.length).toBe(1);
    expect(deadlocks[0]!.processes.length).toBe(2);

    const xeXml = [
      '<RingBufferTarget>',
      '  <event name="error_reported" package="sqlserver" timestamp="2026-11-25T10:15:00.000Z">',
      '    <data name="error_number"><value>1205</value></data>',
      '    <data name="severity"><value>13</value></data>',
      '    <data name="state"><value>51</value></data>',
      '    <data name="message"><value>Transaction was deadlocked on lock resources.</value></data>',
      '    <action name="sql_text" package="sqlserver"><value>UPDATE orders SET note = \'secret-token\' WHERE id = 9182;</value></action>',
      '  </event>',
      '</RingBufferTarget>',
    ].join("\n");
    const xeBatch = parseExtendedEventsXml(xeXml);
    expect(xeBatch.format).toBe("xml");
    expect(xeBatch.records).toHaveLength(1);
    expect(xeBatch.records[0]!.kind.event).toBe("error-reported");
    expect(JSON.stringify(xeBatch)).not.toContain("secret-token");

    const xeShare = await buildShareUrl({
      mode: "events",
      title: "system_health",
      eventsBatch: xeBatch,
      redact: true,
    });
    expect(xeShare.ok).toBe(true);
    if (xeShare.ok) {
      const decodedXe = await decodeShareHash(xeShare.url);
      expect(decodedXe?.m).toBe("events");
      expect(decodedXe?.eb?.records).toHaveLength(1);
    }
    let xelRejectedXml = false;
    try {
      parseXel(new TextEncoder().encode(xeXml));
    } catch {
      xelRejectedXml = true;
    }
    expect(xelRejectedXml).toBe(true);

    // Mock the `vscode` module and load dist/extension.js in CommonJS
    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    const customEditors = new Map<
      string,
      {
        resolveCustomTextEditor?: (...args: unknown[]) => Promise<void>;
        openCustomDocument?: (...args: unknown[]) => Promise<unknown>;
        resolveCustomEditor?: (...args: unknown[]) => Promise<void>;
      }
    >();
    const codeLensProviders: Array<{ provideCodeLenses: (...args: unknown[]) => unknown[] }> = [];
    const diagnosticStore = new Map<string, unknown[]>();
    const openedExternalUrls: string[] = [];
    const createdWebviewPanels: Array<{ title: string; webview: { html: string; posted: unknown[] } }> = [];
    let clipboardText = STUDIO_SAMPLES[0]!.planText!;

    class MockPosition {
      constructor(
        public readonly line: number,
        public readonly character: number,
      ) {}
    }

    class MockRange {
      constructor(
        public readonly start: MockPosition,
        public readonly end: MockPosition,
      ) {}
    }

    class MockCodeLens {
      constructor(
        public readonly range: MockRange,
        public readonly command?: { title: string; command: string; arguments?: unknown[] },
      ) {}
    }

    class MockDiagnostic {
      public source?: string;
      public code?: string;
      constructor(
        public readonly range: MockRange,
        public readonly message: string,
        public readonly severity: number,
      ) {}
    }

    class MockEventEmitter<T> {
      private listeners: Array<(e: T) => void> = [];
      public readonly event = (listener: (e: T) => void) => {
        this.listeners.push(listener);
        return { dispose: () => {} };
      };
      public fire(data: T): void {
        for (const fn of this.listeners) fn(data);
      }
      public dispose(): void {
        this.listeners = [];
      }
    }

    const makeUri = (fsPath: string) => ({
      scheme: "file",
      fsPath,
      path: fsPath,
      toString: () => `file://${fsPath}`,
    });

    const sampleSqlDoc = {
      uri: makeUri("migrations/001.sql"),
      fileName: "migrations/001.sql",
      languageId: "sql",
      getText: () => "SELECT * FROM orders WHERE LOWER(email) = 'x@y.com';\nDELETE FROM temp_logs;",
    };

    const vscodeMock = {
      Position: MockPosition,
      Range: MockRange,
      CodeLens: MockCodeLens,
      Diagnostic: MockDiagnostic,
      EventEmitter: MockEventEmitter,
      DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
      ViewColumn: { One: 1, Beside: 2 },
      Uri: {
        file: makeUri,
        parse: (raw: string) => ({ scheme: "https", fsPath: raw, toString: () => raw }),
        joinPath: (base: { fsPath: string }, ...segments: string[]) =>
          makeUri(path.join(base.fsPath, ...segments)),
      },
      workspace: {
        textDocuments: [sampleSqlDoc],
        workspaceFolders: [{ uri: makeUri(repoRoot) }],
        getConfiguration: () => ({
          get: <T>(_key: string, defaultValue: T): T => defaultValue,
        }),
        onDidOpenTextDocument: () => ({ dispose: () => {} }),
        onDidChangeTextDocument: () => ({ dispose: () => {} }),
        onDidCloseTextDocument: () => ({ dispose: () => {} }),
        onDidChangeConfiguration: () => ({ dispose: () => {} }),
        fs: {
          readFile: async () => new TextEncoder().encode(STUDIO_SAMPLES[0]!.planText!),
          writeFile: async () => {},
        },
      },
      window: {
        activeTextEditor: {
          viewColumn: 1,
          selection: {},
          document: {
            uri: makeUri("slow.explain.json"),
            fileName: "slow.explain.json",
            languageId: "json",
            getText: () => STUDIO_SAMPLES[0]!.planText!,
          },
        },
        registerCustomEditorProvider: (
          viewType: string,
          provider: {
            resolveCustomTextEditor?: (...args: unknown[]) => Promise<void>;
            openCustomDocument?: (...args: unknown[]) => Promise<unknown>;
            resolveCustomEditor?: (...args: unknown[]) => Promise<void>;
          },
        ) => {
          customEditors.set(viewType, provider);
          return { dispose: () => {} };
        },
        createWebviewPanel: (_viewType: string, title: string) => {
          const posted: unknown[] = [];
          const webview = {
            cspSource: "vscode-webview://studio",
            options: {},
            html: "",
            posted,
            asWebviewUri: (u: { fsPath: string }) => ({ toString: () => `vscode-webview://studio/${path.basename(u.fsPath)}` }),
            postMessage: async (m: unknown) => {
              posted.push(m);
              return true;
            },
            onDidReceiveMessage: () => ({ dispose: () => {} }),
          };
          const panel = {
            title,
            active: false,
            viewColumn: 2,
            iconPath: undefined,
            webview,
            reveal: () => {},
            onDidDispose: () => ({ dispose: () => {} }),
            onDidChangeViewState: () => ({ dispose: () => {} }),
          };
          createdWebviewPanels.push({ title, webview });
          return panel;
        },
        showInformationMessage: async () => undefined,
        showWarningMessage: async () => undefined,
        showSaveDialog: async () => undefined,
        showOpenDialog: async () => undefined,
        setStatusBarMessage: () => ({ dispose: () => {} }),
      },
      languages: {
        registerCodeLensProvider: (
          _selector: unknown,
          provider: { provideCodeLenses: (...args: unknown[]) => unknown[] },
        ) => {
          codeLensProviders.push(provider);
          return { dispose: () => {} };
        },
        createDiagnosticCollection: () => ({
          set: (uri: { toString: () => string }, diags: unknown[]) => diagnosticStore.set(uri.toString(), diags),
          delete: (uri: { toString: () => string }) => diagnosticStore.delete(uri.toString()),
          dispose: () => {},
        }),
      },
      commands: {
        registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
          registeredCommands.set(id, handler);
          return { dispose: () => {} };
        },
        executeCommand: async () => {},
      },
      env: {
        clipboard: {
          readText: async () => clipboardText,
          writeText: async (val: string) => {
            clipboardText = val;
          },
        },
        openExternal: async (uri: { toString: () => string }) => {
          openedExternalUrls.push(uri.toString());
          return true;
        },
      },
    };

    await mock.module("vscode", () => vscodeMock);

    try {
      const ext = (await import(path.join(repoRoot, "dist/extension.js"))) as {
        activate: (ctx: { extensionUri: ReturnType<typeof makeUri>; subscriptions: Array<{ dispose: () => void }> }) => void;
        deactivate: () => void;
      };

      const subscriptions: Array<{ dispose: () => void }> = [];
      ext.activate({
        extensionUri: makeUri(repoRoot),
        subscriptions,
      });

      expect(customEditors.has("culprit.planEditor")).toBe(true);
      expect(customEditors.has("culprit.xelEditor")).toBe(true);
      expect(registeredCommands.size).toBe(5);
      expect(codeLensProviders).toHaveLength(1);

      // Diagnostics ran on open SQL document upon activation
      const initialDiags = diagnosticStore.get(sampleSqlDoc.uri.toString());
      expect(initialDiags).toBeDefined();
      expect(initialDiags!.length).toBe(2);

      // CodeLens provider emits Paste EXPLAIN and Compare Plan lenses for both queries
      const lenses = codeLensProviders[0]!.provideCodeLenses(sampleSqlDoc, {}) as MockCodeLens[];
      expect(lenses).toHaveLength(4);
      expect(lenses[0]!.command?.title).toBe("⚡ Culprit: Paste EXPLAIN");
      expect(lenses[1]!.command?.title).toBe("⇄ Compare Plan");

      // Custom Editor resolves .sqlplan / .xdl documents cleanly
      const customPanelWebview = {
        cspSource: "vscode-webview://custom",
        options: {},
        html: "",
        asWebviewUri: (u: { fsPath: string }) => ({ toString: () => `vscode-webview://custom/${path.basename(u.fsPath)}` }),
        postMessage: async () => true,
        onDidReceiveMessage: () => ({ dispose: () => {} }),
      };
      await customEditors.get("culprit.planEditor")!.resolveCustomTextEditor!(
        {
          uri: makeUri("deadlock.xdl"),
          fileName: "deadlock.xdl",
          getText: () => STUDIO_SAMPLES[2]!.deadlockText!,
        },
        {
          active: false,
          webview: customPanelWebview,
          onDidChangeViewState: () => ({ dispose: () => {} }),
          onDidDispose: () => ({ dispose: () => {} }),
        },
        {},
      );
      expect(customPanelWebview.html).toContain("culprit_wasm_bg.wasm");
      expect(customPanelWebview.html).toContain('"mode":"deadlock"');

      // Binary .xel Custom Editor opens raw bytes and embeds xelBase64 in initialState
      const xelProvider = customEditors.get("culprit.xelEditor")!;
      const xelDoc = await xelProvider.openCustomDocument!(makeUri("system_health.xel"), {}, {});
      const xelWebview = {
        cspSource: "vscode-webview://xel",
        options: {},
        html: "",
        asWebviewUri: (u: { fsPath: string }) => ({ toString: () => `vscode-webview://xel/${path.basename(u.fsPath)}` }),
        postMessage: async () => true,
        onDidReceiveMessage: () => ({ dispose: () => {} }),
      };
      await xelProvider.resolveCustomEditor!(
        xelDoc,
        {
          active: false,
          webview: xelWebview,
          onDidChangeViewState: () => ({ dispose: () => {} }),
          onDidDispose: () => ({ dispose: () => {} }),
        },
        {},
      );
      expect(xelWebview.html).toContain('"mode":"events"');
      expect(xelWebview.html).toContain('"xelBase64":');

      // Exercise commands end-to-end
      await registeredCommands.get("culprit.explainClipboard")!();
      expect(createdWebviewPanels.length).toBe(1);
      expect(createdWebviewPanels[0]!.webview.html).toContain("webview.js");

      await registeredCommands.get("culprit.comparePlans")!(
        makeUri("a.explain.json"),
        [makeUri("a.explain.json"), makeUri("b.explain.json")],
      );

      await registeredCommands.get("culprit.openOnline")!();
      expect(openedExternalUrls.length).toBe(1);
      expect(openedExternalUrls[0]!.startsWith(`${EXPLAIN_ONLINE_ORIGIN}/#s=z1.`)).toBe(true);

      ext.deactivate();
    } finally {
      mock.restore();
    }
  });

  test("enforces zero em-dash characters and zero host paths across all repository source files", () => {
    const emDash = String.fromCharCode(0x2014);
    const hostPathPattern = new RegExp(
      ["", "Users", ""].join("\\/") + "|" + ["", "tmp", ""].join("\\/"),
    );

    const walkFiles = (dir: string): string[] => {
      const results: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") {
          continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...walkFiles(full));
        } else if (!entry.name.endsWith(".png")) {
          results.push(full);
        }
      }
      return results;
    };

    const files = walkFiles(repoRoot);
    expect(files.length).toBeGreaterThan(10);

    for (const file of files) {
      const content = readFileSync(file, "utf8");
      const rel = path.relative(repoRoot, file);
      expect(content.includes(emDash)).toBe(false);
      if (hostPathPattern.test(content)) {
        throw new Error(`Found forbidden host path in ${rel}`);
      }
    }
  });
});
