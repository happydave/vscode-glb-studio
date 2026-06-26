import * as vscode from "vscode";
import { HostToWebview, PROTOCOL_VERSION, WebviewToHost } from "./protocol";

/** Minimal read-only custom document: just the file URI. */
class GlbDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  dispose(): void {
    // No held resources; bytes live in the webview.
  }
}

/**
 * Read-only custom editor for `*.glb`. The host serves the file to the webview
 * as a webview-scoped resource URI; the webview fetches and renders it with
 * three.js. M1 is read-only — the file is never modified.
 */
export class GlbEditorProvider
  implements vscode.CustomReadonlyEditorProvider<GlbDocument>
{
  public static readonly viewType = "glbStudio.viewer";

  public static register(
    context: vscode.ExtensionContext,
    log: vscode.LogOutputChannel
  ): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      GlbEditorProvider.viewType,
      new GlbEditorProvider(context, log),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    );
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel
  ) {}

  openCustomDocument(uri: vscode.Uri): GlbDocument {
    return new GlbDocument(uri);
  }

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
    #error {
      position: absolute; inset: 0; display: flex; align-items: center;
      justify-content: center; text-align: center; padding: 24px;
      font: 13px var(--vscode-editor-font-family, sans-serif);
      color: var(--vscode-errorForeground, #f48771);
    }
    #error[hidden] { display: none; }
  </style>
</head>
<body>
  <div id="viewport"></div>
  <div id="stats" hidden></div>
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
