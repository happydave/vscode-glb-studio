# GLB Studio

A VS Code extension that opens glTF binary (`.glb`) files in an interactive 3D
viewport. This is **M1 — viewer core**: a read-only viewer. Later milestones add
Sounding-aware mount overlays, scene inspection, validation, and editing.

See the project docs at `tickets/docs/projects/glb-studio/`.

## Features (M1)

- Opens any `.glb` in a three.js viewport (custom editor for `*.glb`).
- Orbit / pan / zoom camera, image-based lighting for correct PBR, ground grid + axes.
- Auto-frames the model on load.
- Stats overlay: triangle count, material / texture counts, texture dimensions,
  bounding box in metres.
- Unparseable or unsupported files report the cause (viewport + **GLB Studio**
  output channel) instead of failing silently.

## Build

All Node tooling runs in Docker (`Dockerfile.dev` + `Makefile`); nothing is run on
the host. The extension host (`src/extension.ts`) and the webview viewport
(`src/webview/viewer.ts`, which bundles three.js) are built by esbuild into `dist/`.

| Command | Description |
|---|---|
| `make install` | Install dependencies (into host `node_modules/` via mount) |
| `make compile` | Type-check (`tsc --noEmit`) |
| `make bundle` | Build the host + webview bundles into `dist/` |
| `make package` | Produce an installable `.vsix` |
| `make watch` | Rebuild bundles on change |
| `make clean` | Remove `node_modules`, `dist`, and `*.vsix` |

Install the resulting `.vsix` with **Extensions: Install from VSIX…**, then open
any `.glb`.

## License

Released into the public domain under the Unlicense. See the `UNLICENSE` file.
