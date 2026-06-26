import * as vscode from "vscode";
import { validateBytes, ValidatorMessage } from "gltf-validator";

/** Map a glTF-validator severity (0..3) to a VS Code diagnostic severity. */
export function severityToVs(severity: number): vscode.DiagnosticSeverity {
  switch (severity) {
    case 0:
      return vscode.DiagnosticSeverity.Error;
    case 1:
      return vscode.DiagnosticSeverity.Warning;
    default:
      // info (2) and hint (3) — binary glb has no source range to anchor a Hint.
      return vscode.DiagnosticSeverity.Information;
  }
}

/** Build a diagnostic for one validator message (zero range; pointer in text). */
export function toDiagnostic(m: ValidatorMessage): vscode.Diagnostic {
  const where = m.pointer ? ` (${m.pointer})` : "";
  const d = new vscode.Diagnostic(
    new vscode.Range(0, 0, 0, 0),
    `${m.message}${where}`,
    severityToVs(m.severity)
  );
  d.source = "glTF Validator";
  d.code = m.code;
  return d;
}

/**
 * Validate the glb bytes and publish diagnostics on the file URI. Replaces any
 * prior diagnostics for the file (no duplicates); on validator failure, clears
 * them and logs. Never throws; runs independently of rendering.
 */
export async function validateGlb(
  uri: vscode.Uri,
  bytes: Uint8Array,
  collection: vscode.DiagnosticCollection,
  log: vscode.LogOutputChannel
): Promise<void> {
  try {
    const report = await validateBytes(bytes);
    const messages = report.issues.messages ?? [];
    collection.set(uri, messages.map(toDiagnostic));
    const i = report.issues;
    if (messages.length === 0) {
      log.info(`Validator: ${uri.fsPath} is valid`);
    } else {
      log.info(
        `Validator: ${uri.fsPath} — ${i.numErrors} errors, ` +
          `${i.numWarnings} warnings, ${i.numInfos} infos, ${i.numHints} hints`
      );
    }
  } catch (e) {
    collection.delete(uri);
    log.warn(
      `Validator could not run on ${uri.fsPath}: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }
}
