import * as vscode from "vscode";
import { Document } from "@gltf-transform/core";
import { HostToWebview, PROTOCOL_VERSION, WebviewToHost } from "./protocol";
import { resolveManifest } from "./manifestResolver";
import { validateGlb } from "./validation";
import { readDocument, writeDocument } from "./glbModel";

/**
 * Custom document holding the file URI and the authoritative gltf-transform model.
 * `model` is null when the glb could not be parsed into an editable document (the
 * file can still be viewed; saving is unavailable).
 */
class GlbDocument implements vscode.CustomDocument {
  constructor(
    public readonly uri: vscode.Uri,
    public model: Document | null
  ) {}
  dispose(): void {
    // gltf-transform documents hold no OS resources.
  }
}

/**
 * Editor for `*.glb`. The host owns the authoritative gltf-transform document; the
 * webview renders the file and (from M4b) emits edit intents. M4a establishes the
 * editor spine — document, dirty-state plumbing, and a valid save/re-export — with
 * no interactive editing yet.
 */
export class GlbEditorProvider
  implements vscode.CustomEditorProvider<GlbDocument>
{
  public static readonly viewType = "glbStudio.viewer";

  public static register(
    context: vscode.ExtensionContext,
    log: vscode.LogOutputChannel,
    diagnostics: vscode.DiagnosticCollection
  ): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      GlbEditorProvider.viewType,
      new GlbEditorProvider(context, log, diagnostics),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    );
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
    private readonly diagnostics: vscode.DiagnosticCollection
  ) {}

  // VS Code tracks dirty-state and routes save/undo off this event. No edits emit
  // it in M4a; M4b fires it for real edits.
  private readonly _onDidChange =
    new vscode.EventEmitter<vscode.CustomDocumentEditEvent<GlbDocument>>();
  public readonly onDidChangeCustomDocument = this._onDidChange.event;

  // --- Document lifecycle ------------------------------------------------------

  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): Promise<GlbDocument> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    try {
      const model = await readDocument(bytes);
      return new GlbDocument(uri, model);
    } catch (e) {
      this.log.error(
        `Could not parse ${uri.fsPath} into an editable document (view-only): ${
          e instanceof Error ? e.message : String(e)
        }`
      );
      return new GlbDocument(uri, null);
    }
  }

  private async bytesFor(document: GlbDocument): Promise<Uint8Array> {
    if (document.model) return writeDocument(document.model);
    // Unparsed model: preserve the original bytes verbatim.
    return vscode.workspace.fs.readFile(document.uri);
  }

  async saveCustomDocument(
    document: GlbDocument,
    _token: vscode.CancellationToken
  ): Promise<void> {
    await this.writeTo(document, document.uri);
  }

  async saveCustomDocumentAs(
    document: GlbDocument,
    destination: vscode.Uri,
    _token: vscode.CancellationToken
  ): Promise<void> {
    await this.writeTo(document, destination);
  }

  private async writeTo(
    document: GlbDocument,
    target: vscode.Uri
  ): Promise<void> {
    const bytes = await this.bytesFor(document);
    await vscode.workspace.fs.writeFile(target, bytes);
    this.log.info(`Saved ${target.fsPath} (${bytes.byteLength} bytes)`);
  }

  async revertCustomDocument(
    document: GlbDocument,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const bytes = await vscode.workspace.fs.readFile(document.uri);
    document.model = await readDocument(bytes);
    this.log.info(`Reverted ${document.uri.fsPath}`);
  }

  async backupCustomDocument(
    document: GlbDocument,
    context: vscode.CustomDocumentBackupContext,
    _token: vscode.CancellationToken
  ): Promise<vscode.CustomDocumentBackup> {
    const target = context.destination;
    await this.writeTo(document, target);
    return {
      id: target.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(target);
        } catch {
          // Backup already gone; nothing to clean up.
        }
      },
    };
  }

  // --- Webview -----------------------------------------------------------------

  async resolveCustomEditor(
    document: GlbDocument,
    panel: vscode.WebviewPanel
  ): Promise<void> {
    const fileDir = vscode.Uri.joinPath(document.uri, "..");
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist"),
        fileDir,
      ],
    };

    const glbUri = panel.webview.asWebviewUri(document.uri).toString();

    panel.webview.onDidReceiveMessage((msg: WebviewToHost) => {
      switch (msg.type) {
        case "ready":
          if (msg.version !== PROTOCOL_VERSION) {
            this.log.error(
              `Webview protocol mismatch (webview ${msg.version} vs host ${PROTOCOL_VERSION}); ignoring this webview.`
            );
            return;
          }
          this.log.info(`Loading ${document.uri.fsPath}`);
          this.post(panel, {
            type: "load",
            version: PROTOCOL_VERSION,
            uri: glbUri,
          });
          // Resolve the sidecar manifest in the background; the overlay renders
          // regardless of the outcome.
          void resolveManifest(document.uri, this.log).then((enrichment) =>
            this.post(panel, { type: "enrich", enrichment })
          );
          // Validate host-side and publish diagnostics; independent of rendering.
          void vscode.workspace.fs.readFile(document.uri).then(
            (bytes) =>
              validateGlb(document.uri, bytes, this.diagnostics, this.log),
            (e) =>
              this.log.warn(
                `Could not read ${document.uri.fsPath} for validation: ${
                  e instanceof Error ? e.message : String(e)
                }`
              )
          );
          break;
        case "loaded": {
          const b = msg.stats.boundingBoxMetres;
          this.log.info(
            `Rendered ${document.uri.fsPath}: ${msg.stats.triangles} tris, ` +
              `${msg.stats.materials} materials, ${msg.stats.textures} textures, ` +
              `bbox ${b.x.toFixed(3)}x${b.y.toFixed(3)}x${b.z.toFixed(3)} m`
          );
          break;
        }
        case "error":
          this.log.error(
            `Failed to render ${document.uri.fsPath}: ${msg.message}`
          );
          break;
      }
    });

    panel.webview.html = this.html(panel.webview);
  }

  private post(panel: vscode.WebviewPanel, msg: HostToWebview): void {
    void panel.webview.postMessage(msg);
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js")
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `connect-src ${webview.cspSource} blob: data:`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
    #viewport { position: absolute; inset: 0; }
    #stats {
      position: absolute; left: 8px; bottom: 8px;
      font: 12px/1.5 var(--vscode-editor-font-family, monospace);
      color: var(--vscode-foreground); background: rgba(0,0,0,0.45);
      padding: 6px 9px; border-radius: 4px; white-space: pre; pointer-events: none;
    }
    #info {
      position: absolute; right: 8px; top: 8px; max-width: 320px;
      font: 12px/1.5 var(--vscode-editor-font-family, monospace);
      color: var(--vscode-foreground); background: rgba(0,0,0,0.45);
      padding: 6px 9px; border-radius: 4px; white-space: pre-wrap; pointer-events: none;
    }
    #tree {
      position: absolute; left: 8px; top: 8px; max-width: 280px; max-height: 45%;
      overflow: auto; font: 12px/1.4 var(--vscode-editor-font-family, monospace);
      color: var(--vscode-foreground); background: rgba(0,0,0,0.45);
      padding: 6px 9px; border-radius: 4px;
    }
    #tree .node { cursor: pointer; white-space: nowrap; }
    #tree .node:hover { color: var(--vscode-textLink-foreground, #4daafc); }
    #tree .node.sel { color: var(--vscode-textLink-activeForeground, #4daafc); font-weight: bold; }
    #anim {
      position: absolute; left: 50%; bottom: 8px; transform: translateX(-50%);
      display: flex; gap: 6px; align-items: center;
      font: 12px var(--vscode-editor-font-family, monospace);
      color: var(--vscode-foreground); background: rgba(0,0,0,0.45);
      padding: 4px 8px; border-radius: 4px;
    }
    #anim select, #anim button {
      font: inherit; color: var(--vscode-foreground);
      background: var(--vscode-button-secondaryBackground, #3a3d41); border: none;
      padding: 2px 6px; border-radius: 3px; cursor: pointer;
    }
    #error {
      position: absolute; inset: 0; display: flex; align-items: center;
      justify-content: center; text-align: center; padding: 24px;
      font: 13px var(--vscode-editor-font-family, sans-serif);
      color: var(--vscode-errorForeground, #f48771);
    }
    [hidden] { display: none !important; }
    #info .h { opacity: 0.7; }
  </style>
</head>
<body>
  <div id="viewport"></div>
  <div id="tree" hidden></div>
  <div id="stats" hidden></div>
  <div id="info" hidden></div>
  <div id="anim" hidden>
    <select id="clip"></select>
    <button id="playpause">Pause</button>
  </div>
  <div id="error" hidden></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
