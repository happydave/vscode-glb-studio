/**
 * Typed, versioned message protocol shared between the extension host and the
 * webview viewport. The version gates compatibility: a webview reporting a
 * different version than the host is rejected rather than driven.
 */
export const PROTOCOL_VERSION = 1;

/** Default mount-grid cell size (metres) when no manifest supplies one. */
export const DEFAULT_CELL_SIZE_METRES = 0.5;

/** Per-part record matched from a sidecar manifest (all prose fields optional). */
export interface ManifestPart {
  file: string;
  origin?: string;
  orientation?: string;
  materialSet?: string;
}

/**
 * Sidecar-manifest enrichment for the open glb. `part` is present only when an
 * entry matched the file's basename; `frame`/`cellSize` come from the manifest
 * top level. A null enrichment (see the message) means no manifest / parse error.
 */
export interface ManifestEnrichment {
  frame: string;
  cellSize: number;
  part?: ManifestPart;
}

/** Asset statistics derived from the loaded scene (non-authoritative). */
export interface GlbStats {
  triangles: number;
  materials: number;
  textures: number;
  /** Unique texture dimensions, e.g. ["256x256"]. */
  textureDimensions: string[];
  /** Bounding-box extent in metres (glTF units are metres by convention). */
  boundingBoxMetres: { x: number; y: number; z: number };
}

/** Messages sent host -> webview. */
export type HostToWebview =
  | {
      type: "load";
      version: number;
      /** Webview-scoped resource URI of the .glb to fetch and render. */
      uri: string;
    }
  | {
      type: "enrich";
      /** Manifest enrichment, or null when no manifest applies. */
      enrichment: ManifestEnrichment | null;
    };

/** Messages sent webview -> host. */
export type WebviewToHost =
  | { type: "ready"; version: number }
  | { type: "loaded"; stats: GlbStats }
  | { type: "error"; message: string };
