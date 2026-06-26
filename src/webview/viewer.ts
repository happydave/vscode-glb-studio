import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import {
  DEFAULT_CELL_SIZE_METRES,
  GlbStats,
  HostToWebview,
  ManifestEnrichment,
  PROTOCOL_VERSION,
  WebviewToHost,
} from "../protocol";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();
const send = (msg: WebviewToHost): void => vscode.postMessage(msg);

const viewport = document.getElementById("viewport") as HTMLDivElement;
const statsEl = document.getElementById("stats") as HTMLDivElement;
const infoEl = document.getElementById("info") as HTMLDivElement;
const errorEl = document.getElementById("error") as HTMLDivElement;
const treeEl = document.getElementById("tree") as HTMLDivElement;
const animEl = document.getElementById("anim") as HTMLDivElement;
const clipSel = document.getElementById("clip") as HTMLSelectElement;
const playPauseBtn = document.getElementById("playpause") as HTMLButtonElement;

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

// Mount overlay (always on): origin pivot marker + R/G/B axis triad + metre grid.
// By the mechanical-kit convention the geometry origin is the mount pivot, so the
// marker sits at (0,0,0), not the model centre.
const pivot = new THREE.Mesh(
  new THREE.SphereGeometry(1, 16, 12),
  new THREE.MeshBasicMaterial({ color: 0xffcc00 })
);
scene.add(pivot);
const axes = new THREE.AxesHelper(0.5);
scene.add(axes);

let grid = new THREE.GridHelper(2, 4, 0x888888, 0x333333);
scene.add(grid);

let cellSizeMetres = DEFAULT_CELL_SIZE_METRES;
let lastSpanMetres = 1;
let currentModel: THREE.Object3D | null = null;

// Animation + selection state.
const clock = new THREE.Clock();
let mixer: THREE.AnimationMixer | null = null;
let action: THREE.AnimationAction | null = null;
let clips: THREE.AnimationClip[] = [];
let highlight: THREE.BoxHelper | null = null;
let selectedRow: HTMLElement | null = null;

/** Rebuild the ground grid so each cell is `cellSizeMetres` across the model span. */
function rebuildGrid(): void {
  const cells = Math.max(2, Math.ceil(lastSpanMetres / cellSizeMetres) + 2);
  const size = cells * cellSizeMetres;
  scene.remove(grid);
  grid.geometry.dispose();
  (grid.material as THREE.Material).dispose();
  grid = new THREE.GridHelper(size, cells, 0x888888, 0x333333);
  scene.add(grid);
}

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
  const dt = clock.getDelta();
  if (mixer) mixer.update(dt);
  if (highlight) highlight.update();
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
      clearHighlight();
      buildTree(currentModel);
      setupAnimations(gltf.animations ?? []);
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

  // Size the overlay to the model so it stays a useful reference.
  pivot.scale.setScalar(Math.max(radius * 0.03, 0.0005));
  axes.scale.setScalar(Math.max(radius * 2, 0.02));
  lastSpanMetres = Math.max(size.x, size.z, cellSizeMetres);
  rebuildGrid();
}

// --- UI ------------------------------------------------------------------------

function renderStats(s: GlbStats): void {
  const b = s.boundingBoxMetres;
  const dims = s.textureDimensions.length ? s.textureDimensions.join(", ") : "—";
  statsEl.textContent =
    `tris: ${s.triangles.toLocaleString()}\n` +
    `materials: ${s.materials}\n` +
    `textures: ${s.textures} (${dims})\n` +
    `bbox: ${b.x.toFixed(3)} x ${b.y.toFixed(3)} x ${b.z.toFixed(3)} m\n` +
    `axes: X red · Y green · Z blue`;
  statsEl.hidden = false;
}

function renderInfo(e: ManifestEnrichment | null): void {
  if (!e) {
    infoEl.hidden = true;
    infoEl.textContent = "";
    return;
  }
  const lines: string[] = [];
  if (e.frame) lines.push(`frame: ${e.frame}`);
  lines.push(`cell: ${e.cellSize} m`);
  if (e.part) {
    if (e.part.origin) lines.push(`origin: ${e.part.origin}`);
    if (e.part.orientation) lines.push(`orientation: ${e.part.orientation}`);
    if (e.part.materialSet) lines.push(`material: ${e.part.materialSet}`);
  } else {
    lines.push("(no manifest entry for this file)");
  }
  infoEl.textContent = lines.join("\n");
  infoEl.hidden = false;
}

function showError(message: string): void {
  errorEl.textContent = `Could not display this .glb:\n${message}`;
  errorEl.hidden = false;
}

// --- Scene tree + selection ----------------------------------------------------

function buildTree(root: THREE.Object3D): void {
  treeEl.textContent = "";
  const addRow = (obj: THREE.Object3D, depth: number): void => {
    const row = document.createElement("div");
    row.className = "node";
    row.textContent = `${"  ".repeat(depth)}${obj.name || obj.type}`;
    row.addEventListener("click", () => selectNode(obj, row));
    treeEl.appendChild(row);
    for (const child of obj.children) addRow(child, depth + 1);
  };
  addRow(root, 0);
  treeEl.hidden = false;
}

function selectNode(obj: THREE.Object3D, row: HTMLElement): void {
  if (selectedRow) selectedRow.classList.remove("sel");
  selectedRow = row;
  row.classList.add("sel");
  clearHighlight(true);
  highlight = new THREE.BoxHelper(obj, 0xffcc00);
  scene.add(highlight);
}

function clearHighlight(keepRow = false): void {
  if (highlight) {
    scene.remove(highlight);
    highlight.geometry.dispose();
    (highlight.material as THREE.Material).dispose();
    highlight = null;
  }
  if (!keepRow && selectedRow) {
    selectedRow.classList.remove("sel");
    selectedRow = null;
  }
}

// --- Animation -----------------------------------------------------------------

function setupAnimations(animations: THREE.AnimationClip[]): void {
  if (mixer) mixer.stopAllAction();
  mixer = null;
  action = null;
  clips = animations;
  if (clips.length === 0 || !currentModel) {
    animEl.hidden = true;
    return;
  }
  mixer = new THREE.AnimationMixer(currentModel);
  clipSel.textContent = "";
  clips.forEach((c, idx) => {
    const opt = document.createElement("option");
    opt.value = String(idx);
    opt.textContent = c.name || `clip ${idx}`;
    clipSel.appendChild(opt);
  });
  playClip(0);
  animEl.hidden = false;
}

function playClip(index: number): void {
  if (!mixer || !clips[index]) return;
  if (action) action.stop();
  action = mixer.clipAction(clips[index]);
  action.reset().play();
  playPauseBtn.textContent = "Pause";
}

clipSel.addEventListener("change", () => playClip(Number(clipSel.value)));
playPauseBtn.addEventListener("click", () => {
  if (!action) return;
  action.paused = !action.paused;
  playPauseBtn.textContent = action.paused ? "Play" : "Pause";
});

// --- Host channel --------------------------------------------------------------

window.addEventListener("message", (e: MessageEvent<HostToWebview>) => {
  const msg = e.data;
  if (msg.type === "load") {
    loadGlb(msg.uri);
  } else if (msg.type === "enrich") {
    cellSizeMetres = msg.enrichment?.cellSize ?? DEFAULT_CELL_SIZE_METRES;
    rebuildGrid();
    renderInfo(msg.enrichment);
  }
});

send({ type: "ready", version: PROTOCOL_VERSION });
