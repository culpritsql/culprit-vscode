export interface TextPosition {
  /** 0-based line index. */
  line: number;
  /** 0-based UTF-16 character column index. */
  character: number;
}

export interface TextRange {
  start: TextPosition;
  end: TextPosition;
}

export type SqlBlockSource = "sql-file" | "tagged-template";
export type SqlStatementCategory = "query" | "ddl" | "transaction" | "other";

export interface SqlBlock {
  /** Extracted SQL statement text (interpolations replaced with positional placeholders). */
  sql: string;
  /** Short human-readable label for CodeLens / Studio titles. */
  label: string;
  /** Exact 0-based start/end range in the host document. */
  range: TextRange;
  /** Origin of this SQL block. */
  source: SqlBlockSource;
  /** Template tag expression when extracted from TypeScript/JavaScript (e.g. "sql" or "Prisma.$queryRaw"). */
  tag?: string;
  /** Statement classification. */
  category: SqlStatementCategory;
}

export type SqlDiagnosticCode =
  | "culprit-unbounded-mutation"
  | "culprit-index-not-concurrent"
  | "culprit-concurrent-index-in-tx"
  | "culprit-non-sargable-predicate"
  | "culprit-leading-wildcard-like";

export type SqlDiagnosticSeverity = "error" | "warning" | "information";

export interface SqlDiagnosticItem {
  code: SqlDiagnosticCode;
  severity: SqlDiagnosticSeverity;
  message: string;
  range: TextRange;
}

class LineIndex {
  private readonly lineStarts: number[];

  constructor(private readonly text: string) {
    this.lineStarts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) {
        this.lineStarts.push(i + 1);
      }
    }
  }

  positionAt(offset: number): TextPosition {
    const clamped = Math.max(0, Math.min(offset, this.text.length));
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      const start = this.lineStarts[mid]!;
      if (start === clamped) {
        return { line: mid, character: 0 };
      }
      if (start < clamped) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const line = Math.max(0, low - 1);
    return {
      line,
      character: clamped - this.lineStarts[line]!,
    };
  }

  rangeOf(startOffset: number, endOffset: number): TextRange {
    return {
      start: this.positionAt(startOffset),
      end: this.positionAt(Math.max(startOffset, endOffset)),
    };
  }
}

interface SqlToken {
  kind: "word" | "string" | "number" | "symbol";
  text: string;
  upper: string;
  /** Offset relative to the start of the full document! */
  start: number;
  /** End offset relative to the start of the full document! */
  end: number;
}

function isIdentStart(ch: number): boolean {
  return (
    (ch >= 65 && ch <= 90) ||
    (ch >= 97 && ch <= 122) ||
    ch === 95 ||
    ch === 36
  );
}

function isIdentPart(ch: number): boolean {
  return isIdentStart(ch) || (ch >= 48 && ch <= 57);
}

function isWhitespace(ch: number): boolean {
  return ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 12;
}

/**
 * Tokenizes a SQL slice while ignoring `--` line comments, `/* ... *\/` block comments,
 * and preserving single-quoted, double-quoted, bracket-quoted, and dollar-quoted literals.
 * All returned token offsets are shifted by `docBaseOffset` so they map 1:1 to host file offsets.
 */
function tokenizeSqlSlice(sql: string, docBaseOffset: number): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql.charCodeAt(i);

    if (isWhitespace(ch)) {
      i++;
      continue;
    }

    // Single-line comment: -- ...
    if (ch === 45 && i + 1 < n && sql.charCodeAt(i + 1) === 45) {
      i += 2;
      while (i < n && sql.charCodeAt(i) !== 10) i++;
      continue;
    }

    // Block comment: /* ... */
    if (ch === 47 && i + 1 < n && sql.charCodeAt(i + 1) === 42) {
      i += 2;
      while (i + 1 < n && !(sql.charCodeAt(i) === 42 && sql.charCodeAt(i + 1) === 47)) {
        i++;
      }
      i = Math.min(n, i + 2);
      continue;
    }

    // Single-quoted string literal: '...' (with '' or \' escapes)
    if (ch === 39) {
      const start = i;
      i++;
      while (i < n) {
        const c = sql.charCodeAt(i);
        if (c === 39) {
          if (i + 1 < n && sql.charCodeAt(i + 1) === 39) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        if (c === 92 && i + 1 < n) {
          i += 2;
          continue;
        }
        i++;
      }
      const raw = sql.slice(start, i);
      tokens.push({
        kind: "string",
        text: raw,
        upper: raw.toUpperCase(),
        start: docBaseOffset + start,
        end: docBaseOffset + i,
      });
      continue;
    }

    // Double-quoted identifier: "..."
    if (ch === 34) {
      const start = i;
      i++;
      while (i < n) {
        if (sql.charCodeAt(i) === 34) {
          if (i + 1 < n && sql.charCodeAt(i + 1) === 34) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      const raw = sql.slice(start, i);
      const unquoted = raw.slice(1, Math.max(1, raw.length - 1)).replace(/""/g, '"');
      tokens.push({
        kind: "word",
        text: unquoted,
        upper: unquoted.toUpperCase(),
        start: docBaseOffset + start,
        end: docBaseOffset + i,
      });
      continue;
    }

    // Bracket-quoted identifier (SQL Server): [...]
    if (ch === 91) {
      const start = i;
      i++;
      while (i < n && sql.charCodeAt(i) !== 93) i++;
      if (i < n) i++;
      const raw = sql.slice(start, i);
      const unquoted = raw.slice(1, Math.max(1, raw.length - 1));
      tokens.push({
        kind: "word",
        text: unquoted,
        upper: unquoted.toUpperCase(),
        start: docBaseOffset + start,
        end: docBaseOffset + i,
      });
      continue;
    }

    // Backtick-quoted identifier (MySQL / SQLite): `...`
    if (ch === 96) {
      const start = i;
      i++;
      while (i < n && sql.charCodeAt(i) !== 96) i++;
      if (i < n) i++;
      const raw = sql.slice(start, i);
      const unquoted = raw.slice(1, Math.max(1, raw.length - 1));
      tokens.push({
        kind: "word",
        text: unquoted,
        upper: unquoted.toUpperCase(),
        start: docBaseOffset + start,
        end: docBaseOffset + i,
      });
      continue;
    }

    // PostgreSQL dollar-quoted string: $tag$...$tag$ (not positional parameter $1)
    if (ch === 36) {
      const next = i + 1 < n ? sql.charCodeAt(i + 1) : 0;
      if (next === 36 || (isIdentStart(next) && next !== 36)) {
        let tagEnd = i + 1;
        while (tagEnd < n && isIdentPart(sql.charCodeAt(tagEnd)) && sql.charCodeAt(tagEnd) !== 36) {
          tagEnd++;
        }
        if (tagEnd < n && sql.charCodeAt(tagEnd) === 36) {
          const delimiter = sql.slice(i, tagEnd + 1);
          const start = i;
          const closeIdx = sql.indexOf(delimiter, tagEnd + 1);
          i = closeIdx >= 0 ? closeIdx + delimiter.length : n;
          const raw = sql.slice(start, i);
          tokens.push({
            kind: "string",
            text: raw,
            upper: raw.toUpperCase(),
            start: docBaseOffset + start,
            end: docBaseOffset + i,
          });
          continue;
        }
      }
    }

    // Numeric literal
    if (ch >= 48 && ch <= 57) {
      const start = i;
      i++;
      while (i < n && ((sql.charCodeAt(i) >= 48 && sql.charCodeAt(i) <= 57) || sql.charCodeAt(i) === 46)) {
        i++;
      }
      const raw = sql.slice(start, i);
      tokens.push({
        kind: "number",
        text: raw,
        upper: raw,
        start: docBaseOffset + start,
        end: docBaseOffset + i,
      });
      continue;
    }

    // Identifier / keyword / $1 parameter / @param
    if (isIdentStart(ch) || ch === 64) {
      const start = i;
      i++;
      while (i < n && isIdentPart(sql.charCodeAt(i))) {
        i++;
      }
      const raw = sql.slice(start, i);
      tokens.push({
        kind: "word",
        text: raw,
        upper: raw.toUpperCase(),
        start: docBaseOffset + start,
        end: docBaseOffset + i,
      });
      continue;
    }

    // Two-character SQL operators
    const two = i + 1 < n ? sql.slice(i, i + 2) : "";
    if (two === "::" || two === "<=" || two === ">=" || two === "<>" || two === "!=" || two === "||") {
      tokens.push({
        kind: "symbol",
        text: two,
        upper: two,
        start: docBaseOffset + i,
        end: docBaseOffset + i + 2,
      });
      i += 2;
      continue;
    }

    const sym = sql[i]!;
    tokens.push({
      kind: "symbol",
      text: sym,
      upper: sym,
      start: docBaseOffset + i,
      end: docBaseOffset + i + 1,
    });
    i++;
  }

  return tokens;
}

interface RawStatementSlice {
  /** Normalized SQL slice whose length matches `docEnd - docStart` 1:1. */
  normalizedSql: string;
  docStart: number;
  docEnd: number;
  source: SqlBlockSource;
  tag?: string;
}

/**
 * Splits a SQL text slice into individual `;`-delimited statements without splitting inside
 * comments, quoted strings, or dollar-quoted function bodies.
 */
function splitSqlStatements(sql: string, docBaseOffset: number, source: SqlBlockSource, tag?: string): RawStatementSlice[] {
  const tokens = tokenizeSqlSlice(sql, docBaseOffset);
  if (tokens.length === 0) return [];

  const slices: RawStatementSlice[] = [];
  let stmtTokens: SqlToken[] = [];

  const flush = (endTokenEnd?: number) => {
    if (stmtTokens.length === 0) return;
    const first = stmtTokens[0]!;
    const last = stmtTokens[stmtTokens.length - 1]!;
    const docStart = first.start;
    const docEnd = endTokenEnd ?? last.end;
    const localStart = docStart - docBaseOffset;
    const localEnd = docEnd - docBaseOffset;
    slices.push({
      normalizedSql: sql.slice(localStart, localEnd),
      docStart,
      docEnd,
      source,
      tag,
    });
    stmtTokens = [];
  };

  for (const tok of tokens) {
    if (tok.kind === "symbol" && tok.text === ";") {
      flush(tok.end);
    } else {
      stmtTokens.push(tok);
    }
  }
  flush();

  return slices;
}

const RECOGNIZED_SQL_TAGS = /(?:^|\.)(?:sql|\$queryRaw|\$queryRawUnsafe|\$executeRaw|\$executeRawUnsafe|unsafe)$/i;

function isSupportedScriptFile(languageId?: string, fileName?: string): boolean {
  if (languageId) {
    const id = languageId.toLowerCase();
    if (
      id === "typescript" ||
      id === "typescriptreact" ||
      id === "javascript" ||
      id === "javascriptreact"
    ) {
      return true;
    }
  }
  if (fileName) {
    return /\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i.test(fileName);
  }
  return false;
}

function isSupportedSqlFile(languageId?: string, fileName?: string): boolean {
  if (languageId) {
    const id = languageId.toLowerCase();
    if (id === "sql" || id === "pgsql" || id === "postgres" || id === "mysql" || id === "mssql" || id === "sqlite") {
      return true;
    }
  }
  if (fileName) {
    return /\.sql$/i.test(fileName);
  }
  return false;
}

/**
 * Scans TypeScript / JavaScript source to locate SQL tagged template literals
 * (`sql\`...\``, `Prisma.$queryRaw\`...\``, `prisma.$executeRaw<T>\`...\``) while
 * skipping JS comments, strings, and nested `${...}` expressions with exact 1:1 character offsets.
 */
function extractTaggedTemplateSlices(code: string): RawStatementSlice[] {
  const out: RawStatementSlice[] = [];
  const n = code.length;
  let i = 0;

  const skipJsString = (quote: number) => {
    i++;
    while (i < n) {
      const c = code.charCodeAt(i);
      if (c === 92) {
        i += 2;
        continue;
      }
      if (c === quote) {
        i++;
        break;
      }
      i++;
    }
  };

  const readTemplateLiteral = (tag: string | null) => {
    // Assumes code[i] === '`'
    i++; // consume opening '`'
    const bodyStart = i;
    const chars: string[] = [];
    let paramIndex = 1;

    while (i < n) {
      const c = code.charCodeAt(i);
      if (c === 92 && i + 1 < n) {
        chars.push(code[i]!, code[i + 1]!);
        i += 2;
        continue;
      }
      if (c === 96) {
        const bodyEnd = i;
        i++; // consume closing '`'
        if (tag) {
          const normalized = chars.join("");
          out.push(...splitSqlStatements(normalized, bodyStart, "tagged-template", tag));
        }
        return bodyEnd;
      }
      // Template interpolation: ${ ... }
      if (c === 36 && i + 1 < n && code.charCodeAt(i + 1) === 123) {
        const interpStart = i;
        i += 2;
        let braceDepth = 1;
        while (i < n && braceDepth > 0) {
          const ic = code.charCodeAt(i);
          if (ic === 47 && i + 1 < n && code.charCodeAt(i + 1) === 47) {
            i += 2;
            while (i < n && code.charCodeAt(i) !== 10) i++;
            continue;
          }
          if (ic === 47 && i + 1 < n && code.charCodeAt(i + 1) === 42) {
            i += 2;
            while (i + 1 < n && !(code.charCodeAt(i) === 42 && code.charCodeAt(i + 1) === 47)) i++;
            i = Math.min(n, i + 2);
            continue;
          }
          if (ic === 39 || ic === 34) {
            skipJsString(ic);
            continue;
          }
          if (ic === 96) {
            readTemplateLiteral(null);
            continue;
          }
          if (ic === 123) braceDepth++;
          else if (ic === 125) braceDepth--;
          i++;
        }
        const interpRaw = code.slice(interpStart, i);
        // Preserve exact character offsets AND newline positions inside multiline ${...} expressions,
        // placing '(' at '${' and ')' at '}' so the end of the template expression maps to the exact closing '}'!
        const placeholderCore = `$${paramIndex++}`;
        const totalLen = interpRaw.length;
        const wrapParens = totalLen >= placeholderCore.length + 2;
        const innerToken = wrapParens ? `(${placeholderCore}` : placeholderCore;
        const replacementChars: string[] = [];
        let tokenPos = 0;
        for (let k = 0; k < totalLen; k++) {
          const rc = interpRaw.charCodeAt(k);
          if (rc === 10 || rc === 13) {
            replacementChars.push(interpRaw[k]!);
          } else if (wrapParens && k === totalLen - 1) {
            replacementChars.push(")");
          } else if (tokenPos < innerToken.length) {
            replacementChars.push(innerToken[tokenPos++]!);
          } else {
            replacementChars.push(" ");
          }
        }
        chars.push(...replacementChars);
        continue;
      }

      chars.push(code[i]!);
      i++;
    }
    return i;
  };

  while (i < n) {
    const ch = code.charCodeAt(i);

    // JS line comment //
    if (ch === 47 && i + 1 < n && code.charCodeAt(i + 1) === 47) {
      i += 2;
      while (i < n && code.charCodeAt(i) !== 10) i++;
      continue;
    }

    // JS block comment /* ... */
    if (ch === 47 && i + 1 < n && code.charCodeAt(i + 1) === 42) {
      i += 2;
      while (i + 1 < n && !(code.charCodeAt(i) === 42 && code.charCodeAt(i + 1) === 47)) i++;
      i = Math.min(n, i + 2);
      continue;
    }

    // Single or double quoted JS string
    if (ch === 39 || ch === 34) {
      skipJsString(ch);
      continue;
    }

    // Member/identifier chain that might precede a template literal: e.g. sql`...`, Prisma.$queryRaw<Row[]>`...`
    if (isIdentStart(ch)) {
      const chainStart = i;
      while (i < n) {
        while (i < n && isIdentPart(code.charCodeAt(i))) i++;
        if (i < n && code.charCodeAt(i) === 46 && i + 1 < n && isIdentStart(code.charCodeAt(i + 1))) {
          i++; // '.'
          continue;
        }
        break;
      }
      const tagExpr = code.slice(chainStart, i);

      // Skip optional whitespace and optional TypeScript generic type arguments `<...>` before `` ` ``
      let probe = i;
      while (probe < n && isWhitespace(code.charCodeAt(probe))) probe++;
      if (probe < n && code.charCodeAt(probe) === 60) {
        let angleDepth = 1;
        probe++;
        while (probe < n && angleDepth > 0) {
          const ac = code.charCodeAt(probe);
          if (ac === 60) angleDepth++;
          else if (ac === 62) angleDepth--;
          probe++;
        }
        while (probe < n && isWhitespace(code.charCodeAt(probe))) probe++;
      }

      if (probe < n && code.charCodeAt(probe) === 96) {
        i = probe;
        const matchedSqlTag = RECOGNIZED_SQL_TAGS.test(tagExpr) ? tagExpr : null;
        readTemplateLiteral(matchedSqlTag);
        continue;
      }
      continue;
    }

    // Untagged template literal `...`
    if (ch === 96) {
      readTemplateLiteral(null);
      continue;
    }

    i++;
  }

  return out;
}

function classifyStatement(tokens: SqlToken[]): { category: SqlStatementCategory; label: string } {
  const first = tokens[0]?.upper ?? "";
  if (
    first === "SELECT" ||
    first === "WITH" ||
    first === "INSERT" ||
    first === "UPDATE" ||
    first === "DELETE" ||
    first === "MERGE" ||
    first === "VALUES" ||
    first === "EXPLAIN"
  ) {
    const target = findPrimaryObjectHint(tokens, first);
    return {
      category: "query",
      label: target ? `${first} ${target}` : first,
    };
  }
  if (first === "BEGIN" || first === "START" || first === "COMMIT" || first === "END" || first === "ROLLBACK") {
    return { category: "transaction", label: first };
  }
  if (first === "CREATE" || first === "ALTER" || first === "DROP" || first === "TRUNCATE") {
    return { category: "ddl", label: tokens.slice(0, 3).map((t) => t.upper).join(" ") };
  }
  return { category: "other", label: first || "SQL" };
}

function readQualifiedName(tokens: SqlToken[], startIdx: number): { name: string; nextIdx: number } | null {
  const first = tokens[startIdx];
  if (!first || first.kind !== "word") return null;
  const parts = [first.text];
  let idx = startIdx + 1;
  while (idx + 1 < tokens.length && tokens[idx]?.text === "." && tokens[idx + 1]?.kind === "word") {
    parts.push(tokens[idx + 1]!.text);
    idx += 2;
  }
  return { name: parts[parts.length - 1]!.toLowerCase(), nextIdx: idx };
}

function findPrimaryObjectHint(tokens: SqlToken[], verb: string): string | null {
  for (let i = 1; i < tokens.length - 1; i++) {
    const u = tokens[i]!.upper;
    if ((verb === "SELECT" || verb === "DELETE" || verb === "WITH") && u === "FROM") {
      const q = readQualifiedName(tokens, i + 1);
      if (q) return q.name;
    }
    if (verb === "UPDATE" && i === 1) {
      const next = tokens[i]!.upper === "ONLY" ? i + 1 : i;
      const q = readQualifiedName(tokens, next);
      if (q) return q.name;
    }
    if (verb === "INSERT" && u === "INTO") {
      const q = readQualifiedName(tokens, i + 1);
      if (q) return q.name;
    }
  }
  return null;
}

/**
 * Extracts SQL query/DDL blocks with exact 0-based line/character ranges from `.sql` files
 * and SQL tagged template literals (`sql\`...\``, `Prisma.$queryRaw\`...\``) in `.ts`/`.tsx`/`.js`/`.jsx`.
 */
export function extractSqlBlocks(text: string, languageId?: string, fileName?: string): SqlBlock[] {
  const lineIndex = new LineIndex(text);
  const rawSlices = isSupportedScriptFile(languageId, fileName)
    ? extractTaggedTemplateSlices(text)
    : isSupportedSqlFile(languageId, fileName) || (!languageId && !fileName)
      ? splitSqlStatements(text, 0, "sql-file")
      : [];

  const blocks: SqlBlock[] = [];
  for (const slice of rawSlices) {
    const tokens = tokenizeSqlSlice(slice.normalizedSql, slice.docStart);
    if (tokens.length === 0) continue;
    const { category, label } = classifyStatement(tokens);
    blocks.push({
      sql: slice.normalizedSql.trim(),
      label,
      range: lineIndex.rangeOf(slice.docStart, slice.docEnd),
      source: slice.source,
      tag: slice.tag,
      category,
    });
  }
  return blocks;
}

const NON_SARGABLE_FUNCTIONS = new Set([
  "LOWER",
  "UPPER",
  "TRIM",
  "LTRIM",
  "RTRIM",
  "BTRIM",
  "DATE",
  "DATE_TRUNC",
  "DATE_PART",
  "EXTRACT",
  "YEAR",
  "MONTH",
  "DAY",
  "COALESCE",
  "NULLIF",
  "SUBSTRING",
  "SUBSTR",
  "LEFT",
  "RIGHT",
  "ABS",
  "FLOOR",
  "CEIL",
  "CEILING",
  "ROUND",
]);

const COMPARISON_OPS = new Set(["=", "==", "!=", "<>", "<", "<=", ">", ">=", "IN", "LIKE", "ILIKE", "IS"]);

function isStringLiteralStartingWithWildcard(rawLiteral: string): boolean {
  if (!rawLiteral.startsWith("'")) return false;
  const inner = rawLiteral.slice(1, rawLiteral.endsWith("'") ? -1 : undefined);
  return inner.startsWith("%");
}

function detectCreatedTableName(tokens: SqlToken[]): string | null {
  if (tokens[0]?.upper !== "CREATE") return null;
  let idx = 1;
  while (
    idx < tokens.length &&
    (tokens[idx]!.upper === "TEMP" ||
      tokens[idx]!.upper === "TEMPORARY" ||
      tokens[idx]!.upper === "UNLOGGED")
  ) {
    idx++;
  }
  if (tokens[idx]?.upper !== "TABLE") return null;
  idx++;
  if (
    tokens[idx]?.upper === "IF" &&
    tokens[idx + 1]?.upper === "NOT" &&
    tokens[idx + 2]?.upper === "EXISTS"
  ) {
    idx += 3;
  }
  const q = readQualifiedName(tokens, idx);
  return q ? q.name : null;
}

function inspectCreateIndex(
  tokens: SqlToken[],
  inTransaction: boolean,
  tablesCreatedInDocument: ReadonlySet<string>,
  lineIndex: LineIndex,
  diagnostics: SqlDiagnosticItem[],
): void {
  if (tokens[0]?.upper !== "CREATE") return;
  let idx = 1;
  if (tokens[idx]?.upper === "UNIQUE") idx++;
  if (tokens[idx]?.upper !== "INDEX") return;

  const createSpanEnd = tokens[idx]!.end;
  idx++;

  let hasConcurrently = false;
  if (tokens[idx]?.upper === "CONCURRENTLY") {
    hasConcurrently = true;
    const concTok = tokens[idx]!;
    if (inTransaction) {
      diagnostics.push({
        code: "culprit-concurrent-index-in-tx",
        severity: "error",
        message:
          "CREATE INDEX CONCURRENTLY cannot run inside a BEGIN ... COMMIT transaction block. Run this migration outside an explicit transaction.",
        range: lineIndex.rangeOf(tokens[0]!.start, concTok.end),
      });
    }
    idx++;
  }

  if (
    tokens[idx]?.upper === "IF" &&
    tokens[idx + 1]?.upper === "NOT" &&
    tokens[idx + 2]?.upper === "EXISTS"
  ) {
    idx += 3;
  }

  // Advance to ON <table>
  let targetTable: string | null = null;
  for (let k = idx; k < tokens.length - 1; k++) {
    if (tokens[k]!.upper === "ON") {
      const nextIdx = tokens[k + 1]?.upper === "ONLY" ? k + 2 : k + 1;
      const q = readQualifiedName(tokens, nextIdx);
      if (q) targetTable = q.name;
      break;
    }
  }

  // Check if SQL Server WITH (ONLINE = ON) or MySQL LOCK=NONE / ALGORITHM=INPLACE is present
  const hasOnlineOption = tokens.some(
    (t, k) =>
      (t.upper === "ONLINE" && tokens[k + 1]?.text === "=" && tokens[k + 2]?.upper === "ON") ||
      (t.upper === "LOCK" && tokens[k + 1]?.text === "=" && tokens[k + 2]?.upper === "NONE"),
  );

  if (!hasConcurrently && !hasOnlineOption) {
    const isBrandNewTable = targetTable != null && tablesCreatedInDocument.has(targetTable);
    if (!isBrandNewTable) {
      const tableLabel = targetTable ? ` on '${targetTable}'` : "";
      diagnostics.push({
        code: "culprit-index-not-concurrent",
        severity: "warning",
        message: `CREATE INDEX${tableLabel} without CONCURRENTLY blocks writes while building on existing tables. Consider CREATE INDEX CONCURRENTLY (outside a transaction).`,
        range: lineIndex.rangeOf(tokens[0]!.start, createSpanEnd),
      });
    }
  }
}

function inspectUnboundedMutation(
  tokens: SqlToken[],
  lineIndex: LineIndex,
  diagnostics: SqlDiagnosticItem[],
): void {
  // Handle optional leading WITH ... CTE before top-level UPDATE / DELETE
  let mainIdx = 0;
  if (tokens[0]?.upper === "WITH") {
    let parenDepth = 0;
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.text === "(") parenDepth++;
      else if (t.text === ")") parenDepth = Math.max(0, parenDepth - 1);
      else if (parenDepth === 0 && (t.upper === "UPDATE" || t.upper === "DELETE" || t.upper === "SELECT" || t.upper === "INSERT")) {
        mainIdx = i;
        break;
      }
    }
  }

  const head = tokens[mainIdx];
  if (!head) return;

  if (head.upper === "UPDATE") {
    // Verify it is a real DML UPDATE ... SET ... (not FOR UPDATE or ON UPDATE)
    const prev = mainIdx > 0 ? tokens[mainIdx - 1]!.upper : "";
    if (prev === "FOR" || prev === "ON" || prev === "DO") return;

    let hasSet = false;
    let hasTopLevelWhere = false;
    let parenDepth = 0;
    for (let i = mainIdx + 1; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.text === "(") parenDepth++;
      else if (t.text === ")") parenDepth = Math.max(0, parenDepth - 1);
      else if (parenDepth === 0) {
        if (t.upper === "SET") hasSet = true;
        if (t.upper === "WHERE") {
          hasTopLevelWhere = true;
          break;
        }
      }
    }

    if (hasSet && !hasTopLevelWhere) {
      const endTok = tokens[Math.min(tokens.length - 1, mainIdx + 1)]!;
      diagnostics.push({
        code: "culprit-unbounded-mutation",
        severity: "warning",
        message: "UPDATE statement has no WHERE clause and will modify every row in the target table.",
        range: lineIndex.rangeOf(head.start, endTok.end),
      });
    }
  } else if (head.upper === "DELETE") {
    const prev = mainIdx > 0 ? tokens[mainIdx - 1]!.upper : "";
    if (prev === "ON") return;

    let hasFrom = false;
    let hasTopLevelWhere = false;
    let parenDepth = 0;
    for (let i = mainIdx + 1; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.text === "(") parenDepth++;
      else if (t.text === ")") parenDepth = Math.max(0, parenDepth - 1);
      else if (parenDepth === 0) {
        if (t.upper === "FROM") hasFrom = true;
        if (t.upper === "WHERE") {
          hasTopLevelWhere = true;
          break;
        }
      }
    }

    if (hasFrom && !hasTopLevelWhere) {
      const endTok = tokens[Math.min(tokens.length - 1, mainIdx + 2)]!;
      diagnostics.push({
        code: "culprit-unbounded-mutation",
        severity: "warning",
        message: "DELETE statement has no WHERE clause and will delete every row in the target table.",
        range: lineIndex.rangeOf(head.start, endTok.end),
      });
    }
  }
}

function inspectPredicates(
  tokens: SqlToken[],
  lineIndex: LineIndex,
  diagnostics: SqlDiagnosticItem[],
): void {
  // Track whether we are inside a WHERE / HAVING / ON filter clause
  let filterClauseActive = false;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;

    if (tok.upper === "WHERE" || tok.upper === "HAVING") {
      filterClauseActive = true;
    } else if (
      tok.upper === "ORDER" ||
      tok.upper === "GROUP" ||
      tok.upper === "LIMIT" ||
      tok.upper === "OFFSET" ||
      tok.upper === "RETURNING" ||
      tok.upper === "UNION"
    ) {
      filterClauseActive = false;
    }

    // Check 1: Leading wildcard LIKE / ILIKE '%...' anywhere in SQL predicates
    if ((tok.upper === "LIKE" || tok.upper === "ILIKE") && i + 1 < tokens.length) {
      const pat = tokens[i + 1]!;
      if (pat.kind === "string" && isStringLiteralStartingWithWildcard(pat.text)) {
        diagnostics.push({
          code: "culprit-leading-wildcard-like",
          severity: "warning",
          message: `${tok.upper} ${pat.text} starts with a leading '%' wildcard, preventing standard B-tree index seeks. Use a trigram (GIN/GiST) index or full-text search if this table is large.`,
          range: lineIndex.rangeOf(tok.start, pat.end),
        });
      }
    }

    // Check 2: Non-sargable function wrapping a column inside WHERE / HAVING comparisons:
    // e.g. WHERE LOWER(email) = 'alice@example.com' or WHERE DATE(created_at) >= '2026-01-01'
    if (
      filterClauseActive &&
      tok.kind === "word" &&
      NON_SARGABLE_FUNCTIONS.has(tok.upper) &&
      tokens[i + 1]?.text === "("
    ) {
      // Find matching ')' and inspect arguments to verify at least one column identifier is wrapped
      let depth = 1;
      let closeIdx = -1;
      let firstColumnArg: string | null = null;

      for (let k = i + 2; k < tokens.length; k++) {
        const inner = tokens[k]!;
        if (inner.text === "(") depth++;
        else if (inner.text === ")") {
          depth--;
          if (depth === 0) {
            closeIdx = k;
            break;
          }
        } else if (
          depth === 1 &&
          inner.kind === "word" &&
          !inner.text.startsWith("$") &&
          !inner.text.startsWith("@") &&
          inner.upper !== "NULL" &&
          inner.upper !== "TRUE" &&
          inner.upper !== "FALSE" &&
          inner.upper !== "FROM" &&
          tokens[k + 1]?.text !== "("
        ) {
          // If qualified `u.email`, pick `email`
          if (tokens[k + 1]?.text === "." && tokens[k + 2]?.kind === "word") {
            firstColumnArg = `${inner.text}.${tokens[k + 2]!.text}`;
          } else if (tokens[k - 1]?.text !== ".") {
            firstColumnArg = inner.text;
          }
        }
      }

      if (closeIdx > i && firstColumnArg) {
        const afterClose = tokens[closeIdx + 1];
        const prevTok = i > 0 ? tokens[i - 1] : undefined;
        // Trigger when the function call is on either side of a comparison operator (`LOWER(col) = ...`)
        const comparedRight = afterClose != null && COMPARISON_OPS.has(afterClose.upper);
        const comparedLeft = prevTok != null && COMPARISON_OPS.has(prevTok.upper);
        if (comparedRight || comparedLeft) {
          diagnostics.push({
            code: "culprit-non-sargable-predicate",
            severity: "warning",
            message: `Non-sargable predicate ${tok.upper}(${firstColumnArg}) prevents standard B-tree index seeks on '${firstColumnArg}'. Use an expression index on ${tok.upper}(${firstColumnArg}) or rewrite as a direct column range.`,
            range: lineIndex.rangeOf(tok.start, tokens[closeIdx]!.end),
          });
        }
      }
    }
  }
}

/**
 * Runs pure static SQL query & migration safety analysis on `.sql` files and
 * TypeScript / JavaScript SQL tagged template literals.
 */
export function inspectSqlDocument(
  text: string,
  languageId?: string,
  fileName?: string,
): SqlDiagnosticItem[] {
  const lineIndex = new LineIndex(text);
  const slices = isSupportedScriptFile(languageId, fileName)
    ? extractTaggedTemplateSlices(text)
    : isSupportedSqlFile(languageId, fileName) || (!languageId && !fileName)
      ? splitSqlStatements(text, 0, "sql-file")
      : [];

  const diagnostics: SqlDiagnosticItem[] = [];
  const createdTables = new Set<string>();
  let inTransaction = false;

  for (const slice of slices) {
    const tokens = tokenizeSqlSlice(slice.normalizedSql, slice.docStart);
    if (tokens.length === 0) continue;

    const first = tokens[0]!.upper;
    const second = tokens[1]?.upper ?? "";

    // Track explicit transaction boundaries across statements
    if (
      first === "BEGIN" &&
      second !== "ATOMIC" &&
      second !== "TRY" &&
      second !== "CATCH"
    ) {
      inTransaction = true;
      continue;
    }
    if (first === "START" && second === "TRANSACTION") {
      inTransaction = true;
      continue;
    }
    if (first === "COMMIT" || first === "ROLLBACK" || first === "END") {
      inTransaction = false;
      continue;
    }

    const createdTable = detectCreatedTableName(tokens);
    if (createdTable) {
      createdTables.add(createdTable);
    }

    inspectCreateIndex(tokens, inTransaction, createdTables, lineIndex, diagnostics);
    inspectUnboundedMutation(tokens, lineIndex, diagnostics);
    inspectPredicates(tokens, lineIndex, diagnostics);
  }

  return diagnostics;
}
