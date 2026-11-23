import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

// 1. Bundle VS Code Extension Host -> dist/extension.js (Node CommonJS)
await esbuild.build({
  entryPoints: [path.join(rootDir, "src/extension.ts")],
  outfile: path.join(distDir, "extension.js"),
  bundle: true,
  minify: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  sourcemap: false,
  logLevel: "info",
});

// 2. Bundle React Webview App -> dist/webview.js + dist/webview.css (Browser IIFE)
await esbuild.build({
  entryPoints: [path.join(rootDir, "src/webview/index.tsx")],
  outfile: path.join(distDir, "webview.js"),
  bundle: true,
  minify: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  jsx: "automatic",
  define: {
    "process.env.NODE_ENV": '"production"',
    "import.meta.url": "window.location.href",
  },
  sourcemap: false,
  logLevel: "info",
});

// 3. Copy culprit_wasm_bg.wasm from @culpritsql/plans into dist/culprit_wasm_bg.wasm
const plansEntryPath = fileURLToPath(import.meta.resolve("@culpritsql/plans"));
const plansPkgDir = path.dirname(plansEntryPath);
const wasmSourcePath = path.join(plansPkgDir, "native", "culprit_wasm_bg.wasm");
const wasmDestPath = path.join(distDir, "culprit_wasm_bg.wasm");
copyFileSync(wasmSourcePath, wasmDestPath);

// 4. Verify @culpritsql/plan-viewer/styles.css is merged into dist/webview.css
const viewerCssPath = fileURLToPath(import.meta.resolve("@culpritsql/plan-viewer/styles.css"));
const webviewCssPath = path.join(distDir, "webview.css");
const currentCss = existsSync(webviewCssPath) ? readFileSync(webviewCssPath, "utf8") : "";
if (!currentCss.includes(".culprit-pv")) {
  const viewerCss = readFileSync(viewerCssPath, "utf8");
  writeFileSync(webviewCssPath, `${viewerCss}\n${currentCss}`, "utf8");
}

for (const artifact of ["extension.js", "webview.js", "webview.css", "culprit_wasm_bg.wasm"]) {
  const full = path.join(distDir, artifact);
  const bytes = statSync(full).size;
  console.log(`Built dist/${artifact} (${(bytes / 1024).toFixed(1)} KB)`);
}
