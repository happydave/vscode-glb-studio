import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import {
  GlbStats,
  HostToWebview,
  PROTOCOL_VERSION,
  WebviewToHost,
} from "../protocol";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();
const send = (msg: WebviewToHost): void => vscode.postMessage(msg);

const viewport = document.getElementById("viewport") as HTMLDivElement;
const statsEl = document.getElementById("stats") as HTMLDivElement;
const errorEl = document.getElementById("error") as HTMLDivElement;

// --- Renderer / scene / camera -------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();

// Image-based lighting for correct PBR, plus explicit lights for legibility.
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.2);
hemi.position.set(0, 1, 0);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xffffff, 1.5);
key.position.set(3, 5, 2);
scene.add(key);

const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
camera.position.set(2, 1.5, 2);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

// Reference helpers (grid + axes) so scale/orientation read at a glance.
const grid = new THREE.GridHelper(10, 20, 0x666666, 0x333333);
scene.add(grid);
const axes = new THREE.AxesHelper(0.5);
scene.add(axes);

let currentModel: THREE.Object3D | null = null;

// --- Resize / render loop ------------------------------------------------------

function resize(): void {
  const w = viewport.clientWidth || window.innerWidth;
  const h = viewport.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

function tick(): void {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// --- Loading -------------------------------------------------------------------

function loadGlb(url: string): void {
  const loader = new GLTFLoader();
  loader.load(
    url,
    (gltf) => {
      if (currentModel) scene.remove(currentModel);
      currentModel = gltf.scene;
      scene.add(currentModel);
      const stats = computeStats(currentModel);
      frameObject(currentModel);
      renderStats(stats);
      send({ type: "loaded", stats });
    },
    undefined,
    (err: unknown) => {
      const message = describeError(err);
      showError(message);
      send({ type: "error", message });
    }
  );
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

// --- Stats ---------------------------------------------------------------------

function computeStats(root: THREE.Object3D): GlbStats {
  let triangles = 0;
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const dims = new Set<string>();

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;

    const geom = mesh.geometry as THREE.BufferGeometry;
    const pos = geom.getAttribute("position");
    if (geom.index) triangles += geom.index.count / 3;
    else if (pos) triangles += pos.count / 3;

    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (!mat) continue;
      materials.add(mat);
      for (const tex of texturesOf(mat)) {
        textures.add(tex);
        const img = tex.image as { width?: number; height?: number } | undefined;
        if (img && img.width && img.height) dims.add(`${img.width}x${img.height}`);
      }
    }
  });

  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  if (!box.isEmpty()) box.getSize(size);

  return {
    triangles: Math.round(triangles),
    materials: materials.size,
    textures: textures.size,
    textureDimensions: [...dims].sort(),
    boundingBoxMetres: { x: size.x, y: size.y, z: size.z },
  };
}

const TEXTURE_SLOTS = [
  "map",
  "normalMap",
  "roughnessMap",
  "metalnessMap",
  "aoMap",
  "emissiveMap",
] as const;

function texturesOf(mat: THREE.Material): THREE.Texture[] {
  const out: THREE.Texture[] = [];
  const record = mat as unknown as Record<string, unknown>;
  for (const slot of TEXTURE_SLOTS) {
    const value = record[slot];
    if (value && (value as THREE.Texture).isTexture) out.push(value as THREE.Texture);
  }
  return out;
}

// --- Camera framing ------------------------------------------------------------

function frameObject(obj: THREE.Object3D): void {
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return;
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const radius = Math.max(size.x, size.y, size.z, 0.001) * 0.5;
  const fov = (camera.fov * Math.PI) / 180;
  const distance = (radius / Math.sin(fov / 2)) * 1.4;

  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(1, 0.8, 1).normalize().multiplyScalar(distance));
  camera.near = Math.max(distance / 100, 0.001);
  camera.far = distance * 100;
  camera.updateProjectionMatrix();
  controls.update();

  // Size grid/axes to the model so they stay a useful reference.
  const span = Math.max(size.x, size.z, 0.5);
  grid.scale.setScalar(span / 10);
}

// --- UI ------------------------------------------------------------------------

function renderStats(s: GlbStats): void {
  const b = s.boundingBoxMetres;
  const dims = s.textureDimensions.length ? s.textureDimensions.join(", ") : "—";
  statsEl.textContent =
    `tris: ${s.triangles.toLocaleString()}\n` +
    `materials: ${s.materials}\n` +
    `textures: ${s.textures} (${dims})\n` +
    `bbox: ${b.x.toFixed(3)} x ${b.y.toFixed(3)} x ${b.z.toFixed(3)} m`;
  statsEl.hidden = false;
}

function showError(message: string): void {
  errorEl.textContent = `Could not display this .glb:\n${message}`;
  errorEl.hidden = false;
}

// --- Host channel --------------------------------------------------------------

window.addEventListener("message", (e: MessageEvent<HostToWebview>) => {
  const msg = e.data;
  if (msg.type === "load") loadGlb(msg.uri);
});

send({ type: "ready", version: PROTOCOL_VERSION });
