import * as vscode from "vscode";
import { GlbEditorProvider } from "./glbEditorProvider";

export function activate(context: vscode.ExtensionContext): void {
  // LogOutputChannel first, so everything else can log into it.
  const log = vscode.window.createOutputChannel("GLB Studio", { log: true });
  context.subscriptions.push(log);
  log.info("GLB Studio activated");

  context.subscriptions.push(GlbEditorProvider.register(context, log));

  context.subscriptions.push(
    vscode.commands.registerCommand("glbStudio.openOutput", () => log.show())
  );
}

export function deactivate(): void {
  // Resources are disposed via context.subscriptions.
}
