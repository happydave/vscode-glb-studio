import * as vscode from "vscode";
import { Document, Material, Node } from "@gltf-transform/core";
import {
  ExtrasEdit,
  HostToWebview,
  MaterialEdit,
  PROTOCOL_VERSION,
  TransformEdit,
  WebviewToHost,
} from "./protocol";
import { resolveManifest } from "./manifestResolver";
import { validateGlb } from "./validation";
import { readDocument, writeDocument } from "./glbModel";

/**
 * Custom document holding the file URI and the authoritative gltf-transform model.
 * `model` is null when the glb could not be parsed into an editable document (the
 * file can still be viewed; saving is unavailable).
 */
class GlbDocument implements vscode.CustomDocument {
  /** The live editor panel, used to echo undo/redo back to the webview. */
  public panel: vscode.WebviewPanel | null = null;
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
    // Re-render so the viewport matches the reverted (on-disk) document rather than
    // the discarded in-memory edits.
    if (document.panel) {
      const glbUri = document.panel.webview.asWebviewUri(document.uri).toString();
      this.post(document.panel, {
        type: "load",
        version: PROTOCOL_VERSION,
        uri: glbUri,
      });
    }
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

    document.panel = panel;
    panel.onDidDispose(() => {
      if (document.panel === panel) document.panel = null;
    });

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
        case "edit":
          this.handleEdit(document, msg.edit);
          break;
        case "editMaterial":
          this.handleMaterialEdit(document, msg.edit);
          break;
        case "editExtras":
          this.handleExtrasEdit(document, msg.edit);
          break;
      }
    });

    panel.webview.html = this.html(panel.webview);
  }

  // --- Editing -----------------------------------------------------------------

  /** Apply a committed transform intent, recording it as an undoable change. */
  private handleEdit(document: GlbDocument, edit: TransformEdit): void {
    if (!document.model) {
      this.log.warn("Edit ignored: glb is view-only (no editable model)");
      return;
    }
    const node = document.model.getRoot().listNodes()[edit.nodeIndex];
    if (!node) {
      this.log.warn(`Edit ignored: no node at index ${edit.nodeIndex}`);
      return;
    }

    const before: TransformEdit = {
      nodeIndex: edit.nodeIndex,
      translation: [...node.getTranslation()] as [number, number, number],
      rotation: [...node.getRotation()] as [number, number, number, number],
      scale: [...node.getScale()] as [number, number, number],
    };

    // The webview already shows the new transform (live gizmo); apply it to the
    // authoritative model without echoing back.
    this.setNode(node, edit);
    this.log.info(`Edit: node ${edit.nodeIndex} transformed`);

    this._onDidChange.fire({
      document,
      label: "Transform node",
      undo: () => {
        this.setNode(node, before);
        this.echo(document, before);
      },
      redo: () => {
        this.setNode(node, edit);
        this.echo(document, edit);
      },
    });
  }

  private setNode(node: Node, edit: TransformEdit): void {
    node
      .setTranslation(edit.translation)
      .setRotation(edit.rotation)
      .setScale(edit.scale);
  }

  /** Push an authoritative transform to the webview (undo/redo only). */
  private echo(document: GlbDocument, edit: TransformEdit): void {
    if (document.panel) {
      this.post(document.panel, { type: "applyTransform", edit });
    }
  }

  /** Apply a committed material edit to the selected node's material. */
  private handleMaterialEdit(document: GlbDocument, edit: MaterialEdit): void {
    if (!document.model) {
      this.log.warn("Material edit ignored: glb is view-only");
      return;
    }
    const node = document.model.getRoot().listNodes()[edit.nodeIndex];
    const mat = node?.getMesh()?.listPrimitives()[0]?.getMaterial();
    if (!mat) {
      this.log.warn(
        `Material edit ignored: node ${edit.nodeIndex} has no material`
      );
      return;
    }
    const before: MaterialEdit = {
      nodeIndex: edit.nodeIndex,
      baseColorFactor: [...mat.getBaseColorFactor()] as [
        number,
        number,
        number,
        number,
      ],
      metallic: mat.getMetallicFactor(),
      roughness: mat.getRoughnessFactor(),
    };
    this.setMaterial(mat, edit);
    this.log.info(`Edit: node ${edit.nodeIndex} material`);
    this._onDidChange.fire({
      document,
      label: "Edit material",
      undo: () => {
        this.setMaterial(mat, before);
        this.echoMaterial(document, before);
      },
      redo: () => {
        this.setMaterial(mat, edit);
        this.echoMaterial(document, edit);
      },
    });
  }

  private setMaterial(mat: Material, edit: MaterialEdit): void {
    mat
      .setBaseColorFactor(edit.baseColorFactor)
      .setMetallicFactor(edit.metallic)
      .setRoughnessFactor(edit.roughness);
  }

  private echoMaterial(document: GlbDocument, edit: MaterialEdit): void {
    if (document.panel) {
      this.post(document.panel, { type: "applyMaterial", edit });
    }
  }

  /** Apply a committed extras edit to the selected node. */
  private handleExtrasEdit(document: GlbDocument, edit: ExtrasEdit): void {
    if (!document.model) {
      this.log.warn("Extras edit ignored: glb is view-only");
      return;
    }
    const node = document.model.getRoot().listNodes()[edit.nodeIndex];
    if (!node) {
      this.log.warn(`Extras edit ignored: no node at index ${edit.nodeIndex}`);
      return;
    }
    const before: ExtrasEdit = {
      nodeIndex: edit.nodeIndex,
      extras: { ...(node.getExtras() as Record<string, unknown>) },
    };
    node.setExtras(edit.extras);
    this.log.info(`Edit: node ${edit.nodeIndex} extras`);
    this._onDidChange.fire({
      document,
      label: "Edit extras",
      undo: () => {
        node.setExtras(before.extras);
        this.echoExtras(document, before);
      },
      redo: () => {
        node.setExtras(edit.extras);
        this.echoExtras(document, edit);
      },
    });
  }

  private echoExtras(document: GlbDocument, edit: ExtrasEdit): void {
    if (document.panel) {
      this.post(document.panel, { type: "applyExtras", edit });
    }
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
    #viewbar {
      position: absolute; left: 50%; top: 8px; transform: translateX(-50%);
      display: flex; gap: 4px; font: 12px var(--vscode-editor-font-family, monospace);
      background: rgba(0,0,0,0.45); padding: 4px 6px; border-radius: 4px;
    }
    #gizmo {
      position: absolute; left: 50%; top: 42px; transform: translateX(-50%);
      display: flex; gap: 4px; font: 12px var(--vscode-editor-font-family, monospace);
      background: rgba(0,0,0,0.45); padding: 4px 6px; border-radius: 4px;
    }
    #viewbar button, #gizmo button {
      font: inherit; color: var(--vscode-foreground);
      background: var(--vscode-button-secondaryBackground, #3a3d41); border: none;
      padding: 2px 8px; border-radius: 3px; cursor: pointer;
    }
    #viewbar button.active, #gizmo button.active { background: var(--vscode-button-background, #0e639c); }
    #inspector {
      position: absolute; right: 8px; bottom: 8px; width: 248px;
      font: 12px var(--vscode-editor-font-family, monospace); color: var(--vscode-foreground);
      background: rgba(0,0,0,0.5); padding: 8px; border-radius: 4px;
      display: flex; flex-direction: column; gap: 6px;
    }
    #inspector label { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    #inspector input[type="range"] { flex: 1; }
    #inspector textarea {
      width: 100%; box-sizing: border-box; font: inherit; resize: vertical;
      background: var(--vscode-input-background, #1e1e1e);
      color: var(--vscode-input-foreground, #ccc);
      border: 1px solid var(--vscode-input-border, #3c3c3c); border-radius: 3px;
    }
    #inspector button {
      font: inherit; color: var(--vscode-foreground);
      background: var(--vscode-button-secondaryBackground, #3a3d41); border: none;
      padding: 2px 8px; border-radius: 3px; cursor: pointer;
    }
    #exrow { display: flex; gap: 8px; align-items: center; }
    #extrasErr { color: var(--vscode-errorForeground, #f48771); }
    .exlabel { opacity: 0.7; }
    #matinfo {
      white-space: pre-wrap; opacity: 0.85; border-bottom: 1px solid rgba(255,255,255,0.12);
      padding-bottom: 6px;
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
  <div id="viewbar">
    <button id="wireframe">Wireframe</button>
  </div>
  <div id="tree" hidden></div>
  <div id="stats" hidden></div>
  <div id="info" hidden></div>
  <div id="anim" hidden>
    <select id="clip"></select>
    <button id="playpause">Pause</button>
  </div>
  <div id="gizmo" hidden>
    <button data-mode="translate">Move</button>
    <button data-mode="rotate">Rotate</button>
    <button data-mode="scale">Scale</button>
  </div>
  <div id="inspector" hidden>
    <div id="matinfo" hidden></div>
    <div id="matctl" hidden>
      <label>color <input type="color" id="matColor" /></label>
      <label>metal <input type="range" id="matMetal" min="0" max="1" step="0.01" /></label>
      <label>rough <input type="range" id="matRough" min="0" max="1" step="0.01" /></label>
    </div>
    <span class="exlabel">extras (JSON)</span>
    <textarea id="extras" rows="4" spellcheck="false"></textarea>
    <div id="exrow">
      <button id="extrasApply">Apply extras</button>
      <span id="extrasErr"></span>
    </div>
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
