import * as vscode from "vscode";
import { ManifestEnrichment } from "./protocol";
import { matchManifest } from "./manifestMatch";

/**
 * Best-effort: read a `manifest.json` in the glb's directory and match it by
 * basename. Returns null (convention-overlay only) when there is no manifest or
 * it cannot be parsed. Never throws.
 */
export async function resolveManifest(
  glbUri: vscode.Uri,
  log: vscode.LogOutputChannel
): Promise<ManifestEnrichment | null> {
  const basename = glbUri.path.split("/").pop() ?? "";
  const manifestUri = vscode.Uri.joinPath(glbUri, "..", "manifest.json");

  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(manifestUri);
  } catch {
    log.info(`No manifest.json beside ${basename}; convention overlay only`);
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    log.warn(
      `manifest.json beside ${basename} did not parse: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
    return null;
  }

  const enrichment = matchManifest(raw, basename);
  if (enrichment?.part) {
    log.info(`Matched manifest entry for ${basename}`);
  } else {
    log.info(`manifest.json present but no entry matches ${basename}`);
  }
  return enrichment;
}
