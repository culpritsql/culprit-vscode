import * as vscode from "vscode";
import {
  extractSqlBlocks,
  inspectSqlDocument,
  type SqlDiagnosticSeverity,
  type TextRange,
} from "./sqlInspector";

export const SUPPORTED_SQL_SELECTOR: vscode.DocumentSelector = [
  { language: "sql" },
  { language: "pgsql" },
  { language: "mysql" },
  { language: "mssql" },
  { language: "typescript" },
  { language: "typescriptreact" },
  { language: "javascript" },
  { language: "javascriptreact" },
];

function toVsCodeRange(range: TextRange): vscode.Range {
  return new vscode.Range(
    new vscode.Position(range.start.line, range.start.character),
    new vscode.Position(range.end.line, range.end.character),
  );
}

function toVsCodeSeverity(severity: SqlDiagnosticSeverity): vscode.DiagnosticSeverity {
  switch (severity) {
    case "error":
      return vscode.DiagnosticSeverity.Error;
    case "warning":
      return vscode.DiagnosticSeverity.Warning;
    case "information":
      return vscode.DiagnosticSeverity.Information;
  }
}

/**
 * Displays `⚡ Culprit: Paste EXPLAIN · ⇄ Compare Plan` CodeLenses above SQL queries
 * in `.sql` files and TypeScript / JavaScript SQL tagged template literals.
 */
export class CulpritCodeLensProvider implements vscode.CodeLensProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this.changeEmitter.event;

  public refresh(): void {
    this.changeEmitter.fire();
  }

  public dispose(): void {
    this.changeEmitter.dispose();
  }

  public provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): vscode.CodeLens[] {
    const enabled = vscode.workspace
      .getConfiguration("culprit", document.uri)
      .get<boolean>("codeLens.enabled", true);
    if (!enabled) return [];

    const blocks = extractSqlBlocks(document.getText(), document.languageId, document.fileName);
    const lenses: vscode.CodeLens[] = [];

    for (const block of blocks) {
      if (block.category !== "query") continue;
      const lensRange = new vscode.Range(
        new vscode.Position(block.range.start.line, block.range.start.character),
        new vscode.Position(block.range.start.line, block.range.start.character),
      );

      lenses.push(
        new vscode.CodeLens(lensRange, {
          title: "⚡ Culprit: Paste EXPLAIN",
          tooltip: "Open Culprit Studio with this SQL query ready to analyze its EXPLAIN plan",
          command: "culprit.openExplainStudio",
          arguments: [
            {
              mode: "plan",
              sql: block.sql,
              title: block.label,
            },
          ],
        }),
      );

      lenses.push(
        new vscode.CodeLens(lensRange, {
          title: "⇄ Compare Plan",
          tooltip: "Compare Before and After execution plans for this SQL statement",
          command: "culprit.comparePlans",
          arguments: [
            {
              mode: "compare",
              sql: block.sql,
              title: block.label,
            },
          ],
        }),
      );
    }

    return lenses;
  }
}

/**
 * Updates static SQL safety diagnostics in `vscode.DiagnosticCollection` for a document.
 */
export function refreshDocumentSqlDiagnostics(
  document: vscode.TextDocument,
  collection: vscode.DiagnosticCollection,
): void {
  const enabled = vscode.workspace
    .getConfiguration("culprit", document.uri)
    .get<boolean>("diagnostics.enabled", true);

  if (!enabled) {
    collection.delete(document.uri);
    return;
  }

  const items = inspectSqlDocument(document.getText(), document.languageId, document.fileName);
  if (items.length === 0) {
    collection.delete(document.uri);
    return;
  }

  const diagnostics = items.map((item) => {
    const diag = new vscode.Diagnostic(
      toVsCodeRange(item.range),
      item.message,
      toVsCodeSeverity(item.severity),
    );
    diag.source = "Culprit SQL";
    diag.code = item.code;
    return diag;
  });

  collection.set(document.uri, diagnostics);
}
