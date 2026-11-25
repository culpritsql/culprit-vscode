import * as path from "node:path";
import * as vscode from "vscode";
import {
  CulpritCodeLensProvider,
  refreshDocumentSqlDiagnostics,
  SUPPORTED_SQL_SELECTOR,
} from "./codeLensProvider";
import {
  CulpritPlanEditorProvider,
  CulpritStudioController,
  CulpritXelEditorProvider,
  type StudioLaunchOptions,
} from "./planEditorProvider";
import { buildShareUrl, detectInputMode } from "./shareLink";

function looksLikePlanOrDeadlockPayload(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const detected = detectInputMode(trimmed);
  if (detected === "deadlock" || detected === "events") return true;
  if (trimmed.startsWith("<ShowPlanXML") || trimmed.includes("<ShowPlanXML")) return true;
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) return true;
  if (/^\s*(?:QUERY PLAN|->\s|Seq Scan|Index Scan|Index Only Scan|Nested Loop|Hash Join|Limit|Sort|Aggregate|Gather)/im.test(trimmed)) {
    return true;
  }
  if (/`--(?:SCAN|SEARCH)\b/i.test(trimmed)) return true;
  return false;
}

function isStudioLaunchOptions(arg: unknown): arg is StudioLaunchOptions {
  if (!arg || typeof arg !== "object") return false;
  if ("fsPath" in arg || "scheme" in arg) return false;
  return (
    "mode" in arg ||
    "sql" in arg ||
    "text" in arg ||
    "beforeText" in arg ||
    "afterText" in arg ||
    "title" in arg
  );
}

function isVsCodeUri(arg: unknown): arg is vscode.Uri {
  return Boolean(arg && typeof arg === "object" && "fsPath" in arg && "scheme" in arg);
}

async function readUriUtf8(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return new TextDecoder("utf-8").decode(bytes);
}

export function activate(context: vscode.ExtensionContext): void {
  const planEditorProvider = new CulpritPlanEditorProvider(context.extensionUri);
  const xelEditorProvider = new CulpritXelEditorProvider(context.extensionUri);
  const studioController = new CulpritStudioController(context.extensionUri);
  const codeLensProvider = new CulpritCodeLensProvider();
  const diagnostics = vscode.languages.createDiagnosticCollection("culprit-sql");

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      CulpritPlanEditorProvider.viewType,
      planEditorProvider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    ),
    vscode.window.registerCustomEditorProvider(
      CulpritXelEditorProvider.viewType,
      xelEditorProvider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    ),
    vscode.languages.registerCodeLensProvider(SUPPORTED_SQL_SELECTOR, codeLensProvider),
    codeLensProvider,
    diagnostics,
  );

  // Inspect existing open documents and subscribe to workspace edits
  for (const doc of vscode.workspace.textDocuments) {
    refreshDocumentSqlDiagnostics(doc, diagnostics);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      refreshDocumentSqlDiagnostics(doc, diagnostics);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      refreshDocumentSqlDiagnostics(event.document, diagnostics);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      diagnostics.delete(doc.uri);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("culprit.codeLens.enabled")) {
        codeLensProvider.refresh();
      }
      if (event.affectsConfiguration("culprit.diagnostics.enabled")) {
        for (const doc of vscode.workspace.textDocuments) {
          refreshDocumentSqlDiagnostics(doc, diagnostics);
        }
      }
    }),
  );

  // Command 1: Open SQL Plan & Deadlock Studio
  context.subscriptions.push(
    vscode.commands.registerCommand("culprit.openExplainStudio", (arg?: unknown) => {
      if (isStudioLaunchOptions(arg)) {
        studioController.openStudio(arg);
        return;
      }

      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const selected = editor.document.getText(editor.selection).trim();
        if (selected) {
          if (looksLikePlanOrDeadlockPayload(selected)) {
            studioController.openStudio({
              mode: detectInputMode(selected),
              text: selected,
              title: path.basename(editor.document.fileName),
            });
            return;
          }
          studioController.openStudio({
            mode: "plan",
            sql: selected,
            title: path.basename(editor.document.fileName),
          });
          return;
        }
      }

      studioController.openStudio({ mode: "plan" });
    }),
  );

  // Command 2: Explain Plan or Deadlock from Clipboard
  context.subscriptions.push(
    vscode.commands.registerCommand("culprit.explainClipboard", async () => {
      const clip = (await vscode.env.clipboard.readText()).trim();
      if (!clip) {
        vscode.window.showInformationMessage(
          "Clipboard is empty. Opening Culprit Studio so you can paste an EXPLAIN plan or deadlock dump.",
        );
        studioController.openStudio({ mode: "plan" });
        return;
      }

      const mode = detectInputMode(clip);
      studioController.openStudio({
        mode,
        text: clip,
        title:
          mode === "deadlock"
            ? "Clipboard Deadlock"
            : mode === "events"
              ? "Clipboard Extended Events"
              : "Clipboard Plan",
      });
    }),
  );

  // Command 3: Explain Selected Plan / Deadlock
  context.subscriptions.push(
    vscode.commands.registerCommand("culprit.explainSelection", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        studioController.openStudio({ mode: "plan" });
        return;
      }

      const selectionText = editor.document.getText(editor.selection).trim();
      const raw = selectionText || editor.document.getText().trim();
      if (!raw) {
        studioController.openStudio({ mode: "plan" });
        return;
      }

      const fileName = path.basename(editor.document.fileName);
      if (looksLikePlanOrDeadlockPayload(raw)) {
        const mode = detectInputMode(raw, fileName);
        studioController.openStudio({
          mode,
          text: raw,
          title: fileName,
        });
      } else {
        studioController.openStudio({
          mode: "plan",
          sql: raw,
          title: fileName,
        });
      }
    }),
  );

  // Command 4: Compare Two Execution Plans (Explorer multi-select, Editor title, or CodeLens)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "culprit.comparePlans",
      async (primaryArg?: unknown, selectedUris?: vscode.Uri[]) => {
        if (isStudioLaunchOptions(primaryArg)) {
          studioController.openStudio({
            ...primaryArg,
            mode: "compare",
          });
          return;
        }

        const uris: vscode.Uri[] =
          Array.isArray(selectedUris) && selectedUris.length > 0
            ? selectedUris
            : isVsCodeUri(primaryArg)
              ? [primaryArg]
              : vscode.window.activeTextEditor &&
                  /\.(?:sqlplan|json|xdl)$/i.test(vscode.window.activeTextEditor.document.fileName)
                ? [vscode.window.activeTextEditor.document.uri]
                : [];

        if (uris.length >= 2) {
          const [uriA, uriB] = uris;
          const [beforeText, afterText] = await Promise.all([readUriUtf8(uriA!), readUriUtf8(uriB!)]);
          studioController.openStudio({
            mode: "compare",
            beforeName: path.basename(uriA!.fsPath).replace(/\.[^.]+$/, ""),
            beforeText,
            afterName: path.basename(uriB!.fsPath).replace(/\.[^.]+$/, ""),
            afterText,
            title: "Plan Comparison",
          });
          return;
        }

        if (uris.length === 1) {
          const uriA = uris[0]!;
          const beforeText = await readUriUtf8(uriA);
          studioController.openStudio({
            mode: "compare",
            beforeName: path.basename(uriA.fsPath).replace(/\.[^.]+$/, ""),
            beforeText,
            title: "Compare Execution Plans",
          });
          return;
        }

        studioController.openStudio({ mode: "compare", title: "Compare Execution Plans" });
      },
    ),
  );

  // Command 5: Open Redacted Link on explain.culpritsql.com
  context.subscriptions.push(
    vscode.commands.registerCommand("culprit.openOnline", async () => {
      const activeWebviewPanel =
        planEditorProvider.getActivePanel() ??
        xelEditorProvider.getActivePanel() ??
        studioController.getActivePanel();
      if (activeWebviewPanel) {
        studioController.requestShareFromActiveWebview(activeWebviewPanel);
        return;
      }

      const editor = vscode.window.activeTextEditor;
      const selected = editor ? editor.document.getText(editor.selection).trim() : "";
      const fallbackDoc = editor ? editor.document.getText().trim() : "";
      const clip = !selected && !fallbackDoc ? (await vscode.env.clipboard.readText()).trim() : "";
      const raw = selected || fallbackDoc || clip;

      if (!raw) {
        vscode.window.showInformationMessage(
          "Select an execution plan, deadlock report, or Extended Events capture (or open one in Culprit Studio) to share on explain.culpritsql.com.",
        );
        return;
      }

      const fileName = editor ? path.basename(editor.document.fileName) : undefined;
      const mode = detectInputMode(raw, fileName);
      if (mode === "events") {
        const panel = studioController.openStudio({
          mode: "events",
          text: raw,
          title: fileName ? fileName.replace(/\.[^.]+$/, "") : "Extended Events",
        });
        studioController.requestShareFromActiveWebview(panel);
        return;
      }
      const redact = vscode.workspace
        .getConfiguration("culprit")
        .get<boolean>("share.redactLiterals", true);

      const built = await buildShareUrl({
        mode,
        title: fileName ? fileName.replace(/\.[^.]+$/, "") : "Shared from VS Code",
        planText: mode === "plan" ? raw : undefined,
        deadlockText: mode === "deadlock" ? raw : undefined,
        redact,
      });

      if (!built.ok) {
        vscode.window.showWarningMessage(
          "Plan payload exceeds browser URL hash limits. Open it in Culprit Studio and use Export HTML instead.",
        );
        return;
      }

      await vscode.env.clipboard.writeText(built.url);
      await vscode.env.openExternal(vscode.Uri.parse(built.url));
      vscode.window.setStatusBarMessage(
        "Culprit: Copied and opened redacted link on explain.culpritsql.com",
        3000,
      );
    }),
  );
}

export function deactivate(): void {
  // Subscriptions registered on context are disposed automatically by VS Code.
}
