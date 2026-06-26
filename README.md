# GLB Studio

A VS Code extension that opens glTF binary (`.glb`) files in an interactive 3D
viewport and lets you make editor-realistic edits — node transforms, materials, and
metadata — without leaving the editor. Built Sounding-aware: it reads the
mechanical-kit sidecar manifest to annotate mount frames.

See the project docs at `tickets/docs/projects/glb-studio/`.

## Features

**View**
- Opens any `.glb` in a three.js viewport (custom editor for `*.glb`).
- Orbit / pan / zoom camera, image-based lighting for correct PBR, auto-framing.
- Stats overlay: triangles, material / texture counts, texture dimensions, bounding
  box in metres.
- Scene-graph tree with click-to-select highlighting; glTF animation playback.
- Khronos glTF validation surfaced as diagnostics in the Problems panel.
- Unparseable or unsupported files report the cause (viewport + **GLB Studio** output
  channel) instead of failing silently.

**Sounding overlays**
- Always-on mount overlay: origin/pivot marker, `+X`/`+Y`/`+Z` axis triad, and a metre
  grid sized to the manifest `cell_size` (default 0.5 m).
- Reads a sibling `manifest.json`, matches by filename, and shows the part's frame /
  origin / orientation / material in an info panel.

**Edit**
- A full custom editor backed by a host-side `gltf-transform` document (authoritative
  source of truth), with dirty-state, save, revert, and backup.
- Transform gizmos (move / rotate / scale) with a latency-free preview-then-commit
  model; material editing (base colour, metallic, roughness); node `extras` JSON editing.
- Per-edit undo/redo; saves re-export to a valid glb.

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
