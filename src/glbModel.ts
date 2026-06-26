import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";

/**
 * Authoritative-model IO. A single NodeIO with all known glTF extensions
 * registered so embedded textures and `KHR_texture_transform` (used by the
 * mechanical-kit parts) round-trip correctly.
 */
function createIO(): NodeIO {
  return new NodeIO().registerExtensions(ALL_EXTENSIONS);
}

const io = createIO();

/** Parse glb bytes into an authoritative gltf-transform Document. */
export async function readDocument(bytes: Uint8Array): Promise<Document> {
  return io.readBinary(bytes);
}

/** Re-export an authoritative Document back to glb bytes. */
export async function writeDocument(doc: Document): Promise<Uint8Array> {
  return io.writeBinary(doc);
}
