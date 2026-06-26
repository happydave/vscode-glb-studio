import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: "info",
  minify: !watch,
};

/** Extension host bundle (Node, CommonJS, vscode external). */
const host = {
  ...common,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  external: ["vscode"],
};

/** Webview bundle (browser, IIFE, bundles three.js). */
const webview = {
  ...common,
  entryPoints: ["src/webview/viewer.ts"],
  outfile: "dist/webview.js",
  platform: "browser",
  format: "iife",
};

if (watch) {
  const ctxs = await Promise.all([esbuild.context(host), esbuild.context(webview)]);
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log("esbuild watching…");
} else {
  await Promise.all([esbuild.build(host), esbuild.build(webview)]);
}
