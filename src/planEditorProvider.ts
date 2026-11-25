import * as path from "node:path";
import * as vscode from "vscode";
import type { FileSlot, HostToWebviewMessage, WebviewToHostMessage } from "./protocol";
import { decodeTextBytes, detectInputMode, EXPLAIN_ONLINE_ORIGIN, hasXelMagic } from "./shareLink";
import { buildWebviewHtml, type StudioMode, type WebviewInitialState } from "./webviewHtml";

function getRedactSetting(): boolean {
  return vscode.workspace.getConfiguration("culprit").get<boolean>("share.redactLiterals", true);
}

function configureWebviewAssets(webview: vscode.Webview, extensionUri: vscode.Uri) {
  const distRoot = vscode.Uri.joinPath(extensionUri, "dist");
  const mediaRoot = vscode.Uri.joinPath(extensionUri, "media");
  webview.options = {
    enableScripts: true,
    localResourceRoots: [distRoot, mediaRoot],
  };

  return {
    scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(distRoot, "webview.js")).toString(),
    styleUri: webview.asWebviewUri(vscode.Uri.joinPath(distRoot, "webview.css")).toString(),
    wasmUri: webview.asWebviewUri(vscode.Uri.joinPath(distRoot, "culprit_wasm_bg.wasm")).toString(),
    iconUri: webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "icon.svg")).toString(),
  };
}

async function handleWebviewMessage(
  msg: WebviewToHostMessage,
  panel: vscode.WebviewPanel,
  onReady?: () => void,
): Promise<void> {
  switch (msg.type) {
    case "ready": {
      onReady?.();
      break;
    }
    case "copy": {
      await vscode.env.clipboard.writeText(msg.text);
      const suffix = msg.label ? `: ${msg.label}` : "";
      vscode.window.setStatusBarMessage(`Culprit: Copied to clipboard${suffix}`, 2500);
      break;
    }
    case "exportFile": {
      const filters: Record<string, string[]> =
        msg.format === "html"
          ? { "HTML Report": ["html"] }
          : msg.format === "markdown"
            ? { "Markdown Report": ["md"] }
            : { "Execution Plan": ["sqlplan", "json", "txt", "xml"] };

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
      const defaultUri = workspaceFolder
        ? vscode.Uri.joinPath(workspaceFolder, msg.suggestedName)
        : vscode.Uri.file(msg.suggestedName);

      const targetUri = await vscode.window.showSaveDialog({
        defaultUri,
        filters,
        saveLabel: "Export Report",
      });
      if (!targetUri) return;

      const bytes = new TextEncoder().encode(msg.contents);
      await vscode.workspace.fs.writeFile(targetUri, bytes);
      const picked = await vscode.window.showInformationMessage(
        `Saved ${path.basename(targetUri.fsPath)}`,
        "Open File",
      );
      if (picked === "Open File") {
        await vscode.commands.executeCommand("vscode.open", targetUri);
      }
      break;
    }
    case "openOnline": {
      if (!msg.url.startsWith(EXPLAIN_ONLINE_ORIGIN)) {
        vscode.window.showWarningMessage("Blocked external URL outside explain.culpritsql.com.");
        return;
      }
      if (msg.copyToClipboard !== false) {
        await vscode.env.clipboard.writeText(msg.url);
      }
      await vscode.env.openExternal(vscode.Uri.parse(msg.url));
      vscode.window.setStatusBarMessage("Culprit: Opened redacted link on explain.culpritsql.com", 3000);
      break;
    }
    case "pickFile": {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: "Load Execution Plan, Deadlock, or .xel",
        filters: {
          "Execution Plans, Deadlocks & Extended Events": [
            "sqlplan",
            "xel",
            "json",
            "xdl",
            "xml",
            "txt",
            "log",
          ],
          "All Files": ["*"],
        },
      });
      const uri = uris?.[0];
      if (!uri) return;
      const rawBytes = await vscode.workspace.fs.readFile(uri);
      const pickedName = path.basename(uri.fsPath);
      const isXel = /\.xel$/i.test(pickedName) || hasXelMagic(rawBytes);
      const reply: HostToWebviewMessage = isXel
        ? {
            type: "filePicked",
            slot: msg.slot,
            name: pickedName,
            xelBase64: Buffer.from(rawBytes).toString("base64"),
          }
        : {
            type: "filePicked",
            slot: msg.slot,
            name: pickedName,
            text: decodeTextBytes(rawBytes),
          };
      await panel.webview.postMessage(reply);
      break;
    }
    case "modeChanged": {
      break;
    }
  }
}

/**
 * CustomTextEditorProvider for `.sqlplan`, `.explain.json`, `.plan.json`, and `.xdl` files.
 */
export class CulpritPlanEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = "culprit.planEditor";

  private activePanel: vscode.WebviewPanel | null = null;

  constructor(private readonly extensionUri: vscode.Uri) {}

  public getActivePanel(): vscode.WebviewPanel | null {
    return this.activePanel?.active ? this.activePanel : null;
  }

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const assets = configureWebviewAssets(webviewPanel.webview, this.extensionUri);
    const fileName = path.basename(document.fileName);
    const rawText = document.getText();
    const detectedMode = detectInputMode(rawText, fileName);

    const initialState: WebviewInitialState = {
      kind: "document",
      mode: detectedMode,
      title: fileName.replace(/\.[^.]+$/, ""),
      fileName,
      text: rawText,
      redactLiterals: getRedactSetting(),
    };

    webviewPanel.webview.html = buildWebviewHtml({
      cspSource: webviewPanel.webview.cspSource,
      scriptUri: assets.scriptUri,
      styleUri: assets.styleUri,
      wasmUri: assets.wasmUri,
      iconUri: assets.iconUri,
      title: `Culprit: ${fileName}`,
      initialState,
    });

    if (webviewPanel.active) {
      this.activePanel = webviewPanel;
    }

    const viewStateSub = webviewPanel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        this.activePanel = e.webviewPanel;
      } else if (this.activePanel === e.webviewPanel) {
        this.activePanel = null;
      }
    });

    const docChangeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      const updatedText = e.document.getText();
      const updatedMode = detectInputMode(updatedText, fileName);
      const message: HostToWebviewMessage = {
        type: "documentChanged",
        mode: updatedMode,
        fileName,
        text: updatedText,
      };
      void webviewPanel.webview.postMessage(message);
    });

    const msgSub = webviewPanel.webview.onDidReceiveMessage((msg: WebviewToHostMessage) => {
      void handleWebviewMessage(msg, webviewPanel);
    });

    webviewPanel.onDidDispose(() => {
      if (this.activePanel === webviewPanel) {
        this.activePanel = null;
      }
      viewStateSub.dispose();
      docChangeSub.dispose();
      msgSub.dispose();
    });
  }
}

export interface CulpritXelDocument extends vscode.CustomDocument {
  readonly bytes: Uint8Array;
}

/**
 * CustomReadonlyEditorProvider for binary SQL Server Extended Events (`.xel`) files.
 */
export class CulpritXelEditorProvider implements vscode.CustomReadonlyEditorProvider<CulpritXelDocument> {
  public static readonly viewType = "culprit.xelEditor";

  private activePanel: vscode.WebviewPanel | null = null;

  constructor(private readonly extensionUri: vscode.Uri) {}

  public getActivePanel(): vscode.WebviewPanel | null {
    return this.activePanel?.active ? this.activePanel : null;
  }

  public async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): Promise<CulpritXelDocument> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return {
      uri,
      bytes,
      dispose: () => {},
    };
  }

  public async resolveCustomEditor(
    document: CulpritXelDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const assets = configureWebviewAssets(webviewPanel.webview, this.extensionUri);
    const fileName = path.basename(document.uri.fsPath);

    const initialState: WebviewInitialState = {
      kind: "document",
      mode: "events",
      title: fileName.replace(/\.[^.]+$/, ""),
      fileName,
      xelBase64: Buffer.from(document.bytes).toString("base64"),
      redactLiterals: getRedactSetting(),
    };

    webviewPanel.webview.html = buildWebviewHtml({
      cspSource: webviewPanel.webview.cspSource,
      scriptUri: assets.scriptUri,
      styleUri: assets.styleUri,
      wasmUri: assets.wasmUri,
      iconUri: assets.iconUri,
      title: `Culprit: ${fileName}`,
      initialState,
    });

    if (webviewPanel.active) {
      this.activePanel = webviewPanel;
    }

    const viewStateSub = webviewPanel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        this.activePanel = e.webviewPanel;
      } else if (this.activePanel === e.webviewPanel) {
        this.activePanel = null;
      }
    });

    const msgSub = webviewPanel.webview.onDidReceiveMessage((msg: WebviewToHostMessage) => {
      void handleWebviewMessage(msg, webviewPanel);
    });

    webviewPanel.onDidDispose(() => {
      if (this.activePanel === webviewPanel) {
        this.activePanel = null;
      }
      viewStateSub.dispose();
      msgSub.dispose();
    });
  }
}

export interface StudioLaunchOptions {
  mode?: StudioMode;
  title?: string;
  text?: string;
  xelBase64?: string;
  sql?: string;
  beforeName?: string;
  beforeText?: string;
  afterName?: string;
  afterText?: string;
}

/**
 * Manages the interactive Culprit SQL Plan & Deadlock Studio WebviewPanel.
 */
export class CulpritStudioController {
  private studioPanel: vscode.WebviewPanel | null = null;
  private studioReady = false;
  private pendingState: WebviewInitialState | null = null;

  constructor(private readonly extensionUri: vscode.Uri) {}

  public getActivePanel(): vscode.WebviewPanel | null {
    return this.studioPanel?.active ? this.studioPanel : null;
  }

  public openStudio(options: StudioLaunchOptions = {}): vscode.WebviewPanel {
    const state: WebviewInitialState = {
      kind: "studio",
      mode: options.mode ?? "plan",
      title: options.title,
      text: options.text,
      xelBase64: options.xelBase64,
      sql: options.sql,
      beforeName: options.beforeName,
      beforeText: options.beforeText,
      afterName: options.afterName,
      afterText: options.afterText,
      redactLiterals: getRedactSetting(),
    };

    const column = vscode.window.activeTextEditor?.viewColumn
      ? vscode.ViewColumn.Beside
      : vscode.ViewColumn.One;

    if (this.studioPanel) {
      this.studioPanel.reveal(this.studioPanel.viewColumn ?? column, false);
      if (this.studioReady) {
        const msg: HostToWebviewMessage = { type: "loadState", state };
        void this.studioPanel.webview.postMessage(msg);
      } else {
        this.pendingState = state;
      }
      return this.studioPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      "culprit.studio",
      options.title ? `Culprit: ${options.title}` : "Culprit SQL Studio",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "media", "icon.svg");

    const assets = configureWebviewAssets(panel.webview, this.extensionUri);
    this.studioPanel = panel;
    this.studioReady = false;
    this.pendingState = null;

    panel.webview.html = buildWebviewHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: assets.scriptUri,
      styleUri: assets.styleUri,
      wasmUri: assets.wasmUri,
      iconUri: assets.iconUri,
      title: "Culprit SQL Studio",
      initialState: state,
    });

    const msgSub = panel.webview.onDidReceiveMessage((msg: WebviewToHostMessage) => {
      void handleWebviewMessage(msg, panel, () => {
        this.studioReady = true;
        if (this.pendingState) {
          const queued: HostToWebviewMessage = { type: "loadState", state: this.pendingState };
          this.pendingState = null;
          void panel.webview.postMessage(queued);
        }
      });
    });

    panel.onDidDispose(() => {
      this.studioPanel = null;
      this.studioReady = false;
      this.pendingState = null;
      msgSub.dispose();
    });

    return panel;
  }

  public requestShareFromActiveWebview(panel: vscode.WebviewPanel): void {
    const msg: HostToWebviewMessage = {
      type: "requestShareOnline",
      redact: getRedactSetting(),
    };
    void panel.webview.postMessage(msg);
  }
}

export type { FileSlot };
