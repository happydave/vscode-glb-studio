import {
  DEFAULT_CELL_SIZE_METRES,
  ManifestEnrichment,
  ManifestPart,
} from "./protocol";

/**
 * Pure matcher: given parsed manifest JSON and the open glb's basename, build the
 * enrichment. Returns the top-level frame/cellSize always; `part` only when an
 * entry's `file` equals the basename. Returns null only when `raw` is not an
 * object (an unusable manifest). Missing/invalid optional fields are dropped, not
 * surfaced as "undefined". This module is dependency-free (no `vscode`) so it can
 * be unit-tested in plain Node.
 */
export function matchManifest(
  raw: unknown,
  basename: string
): ManifestEnrichment | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const frame = typeof obj.frame === "string" ? obj.frame : "";
  const cellSize =
    typeof obj.cell_size === "number" && obj.cell_size > 0
      ? obj.cell_size
      : DEFAULT_CELL_SIZE_METRES;

  let part: ManifestPart | undefined;
  if (obj.parts && typeof obj.parts === "object") {
    for (const value of Object.values(obj.parts as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const p = value as Record<string, unknown>;
      if (p.file === basename) {
        part = { file: basename };
        if (typeof p.origin === "string") part.origin = p.origin;
        if (typeof p.orientation === "string") part.orientation = p.orientation;
        if (typeof p.material_set === "string") part.materialSet = p.material_set;
        break;
      }
    }
  }

  return { frame, cellSize, part };
}
