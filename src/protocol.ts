/**
 * Typed, versioned message protocol shared between the extension host and the
 * webview viewport. The version gates compatibility: a webview reporting a
 * different version than the host is rejected rather than driven.
 */
export const PROTOCOL_VERSION = 1;

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
export type HostToWebview = {
  type: "load";
  version: number;
  /** Webview-scoped resource URI of the .glb to fetch and render. */
  uri: string;
};

/** Messages sent webview -> host. */
export type WebviewToHost =
  | { type: "ready"; version: number }
  | { type: "loaded"; stats: GlbStats }
  | { type: "error"; message: string };
