import * as THREE from "three";
import { GLTF, GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import {
  DEFAULT_CELL_SIZE_METRES,
  ExtrasEdit,
  GlbStats,
  HostToWebview,
  ManifestEnrichment,
  MaterialEdit,
  PROTOCOL_VERSION,
  TransformEdit,
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
const gizmoEl = document.getElementById("gizmo") as HTMLDivElement;
const wireframeBtn = document.getElementById("wireframe") as HTMLButtonElement;
const inspectorEl = document.getElementById("inspector") as HTMLDivElement;
const matCtlEl = document.getElementById("matctl") as HTMLDivElement;
const matColor = document.getElementById("matColor") as HTMLInputElement;
const matMetal = document.getElementById("matMetal") as HTMLInputElement;
const matRough = document.getElementById("matRough") as HTMLInputElement;
const extrasEl = document.getElementById("extras") as HTMLTextAreaElement;
const extrasApply = document.getElementById("extrasApply") as HTMLButtonElement;
const extrasErr = document.getElementById("extrasErr") as HTMLSpanElement;
const matInfoEl = document.getElementById("matinfo") as HTMLDivElement;

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

// Transform gizmo for editing the selected node (M4b). Dragging is an ephemeral
// local preview; a single committed intent is sent to the host on gesture end.
const gizmo = new TransformControls(camera, renderer.domElement);
type WithHelper = { getHelper?: () => THREE.Object3D };
const gizmoHelper = (gizmo as unknown as WithHelper).getHelper
  ? (gizmo as unknown as Required<WithHelper>).getHelper()
  : (gizmo as unknown as THREE.Object3D);
scene.add(gizmoHelper);
gizmo.addEventListener("dragging-changed", (e) => {
  const dragging = (e as unknown as { value: boolean }).value;
  controls.enabled = !dragging; // orbit off while dragging the gizmo
  if (!dragging) commitTransform();
});

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

// Mount indicator: an arrow pointing at the pivot from outside the asset, with a
// "mount" label, so the mount point is findable even when the pivot sits inside the
// geometry. Drawn depth-test-free so the mesh never hides it.
const mountArrow = new THREE.ArrowHelper(
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(),
  1,
  0xffcc00
);
(mountArrow.line.material as THREE.LineBasicMaterial).depthTest = false;
(mountArrow.cone.material as THREE.MeshBasicMaterial).depthTest = false;
mountArrow.renderOrder = 999;
mountArrow.visible = false;
scene.add(mountArrow);

const mountLabel = makeTextSprite("mount");
mountLabel.visible = false;
scene.add(mountLabel);

function makeTextSprite(text: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = "44px sans-serif";
  ctx.fillStyle = "#ffcc00";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: tex,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    })
  );
  sprite.renderOrder = 1000;
  return sprite;
}

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

// glTF node-index <-> three object mapping (shared identity with the host).
const nodeByIndex = new Map<number, THREE.Object3D>();
const indexByObject = new Map<THREE.Object3D, number>();
let selectedObject: THREE.Object3D | null = null;
let selectedMaterial: THREE.MeshStandardMaterial | null = null;

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
      resetGizmo();
      void populateNodeMaps(gltf);
      buildTree(currentModel);
      setupAnimations(gltf.animations ?? []);
      applyWireframe();
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

  // Mount indicator: anchor outside the asset on the side the pivot lies (origin
  // relative to centroid), pointing the arrow back at the pivot. Falls back to
  // straight down when the pivot ~ the centroid (axially-symmetric parts).
  const sphereR = Math.max(radius, 0.001);
  const outward = new THREE.Vector3(0, 0, 0).sub(center);
  if (outward.lengthSq() < 1e-8) outward.set(0, -1, 0);
  outward.normalize();
  const len = sphereR * 1.3; // tip lands on the pivot; anchor clears the bounds
  mountArrow.position.copy(outward).multiplyScalar(len);
  mountArrow.setDirection(outward.clone().multiplyScalar(-1));
  mountArrow.setLength(len, len * 0.18, len * 0.1);
  mountLabel.position.copy(outward).multiplyScalar(len * 1.14);
  const labelW = sphereR * 0.9;
  mountLabel.scale.set(labelW, labelW * 0.25, 1);
  mountArrow.visible = true;
  mountLabel.visible = true;
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

  selectedObject = obj;
  const idx = indexByObject.get(obj);
  if (idx !== undefined) {
    gizmo.attach(obj);
    gizmoEl.hidden = false;
    inspectorEl.hidden = false;
    selectedMaterial = findMaterial(obj);
    if (selectedMaterial) {
      matCtlEl.hidden = false;
      populateMaterialControls(selectedMaterial);
    } else {
      matCtlEl.hidden = true;
    }
    extrasEl.value = JSON.stringify(obj.userData ?? {}, null, 2);
    extrasErr.textContent = "";
    renderMaterialInfo(selectedMaterial);
  } else {
    // Not a glTF node (e.g. the Scene root) — selectable/highlightable, not editable.
    gizmo.detach();
    gizmoEl.hidden = true;
    inspectorEl.hidden = true;
    selectedMaterial = null;
  }
}

/** Read-only material readout for the selected node. */
function renderMaterialInfo(mat: THREE.MeshStandardMaterial | null): void {
  if (!mat) {
    matInfoEl.textContent = "no material";
    matInfoEl.hidden = false;
    return;
  }
  const c = mat.color;
  const hex = "#" + c.getHexString(THREE.SRGBColorSpace);
  const lines = [
    `material: ${mat.name || "(unnamed)"}`,
    `base color: ${hex}  rgba(${c.r.toFixed(2)}, ${c.g.toFixed(2)}, ${c.b.toFixed(2)}, ${mat.opacity.toFixed(2)})`,
    `metal: ${mat.metalness.toFixed(2)}   rough: ${mat.roughness.toFixed(2)}`,
  ];
  const seen = new Set<THREE.Texture>();
  const maps: string[] = [];
  const addMap = (label: string, tex: THREE.Texture | null | undefined): void => {
    if (!tex || seen.has(tex)) return;
    seen.add(tex);
    const img = tex.image as { width?: number; height?: number } | undefined;
    const dim = img && img.width && img.height ? ` ${img.width}×${img.height}` : "";
    maps.push(`${label}${dim}`);
  };
  addMap("albedo", mat.map);
  addMap("normal", mat.normalMap);
  addMap("metallic-roughness", mat.metalnessMap ?? mat.roughnessMap);
  addMap("emissive", mat.emissiveMap);
  addMap("ao", mat.aoMap);
  lines.push(`maps: ${maps.length ? maps.join(", ") : "none"}`);
  const users = materialUserCount(mat);
  if (users > 1) lines.push(`shared by ${users} nodes`);
  matInfoEl.textContent = lines.join("\n");
  matInfoEl.hidden = false;
}

function materialUserCount(mat: THREE.Material): number {
  let n = 0;
  currentModel?.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (mats.includes(mat)) n++;
  });
  return n;
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

// --- Wireframe mode ------------------------------------------------------------

let wireframe = false;

function applyWireframe(): void {
  if (!currentModel) return;
  currentModel.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) (m as THREE.MeshStandardMaterial).wireframe = wireframe;
  });
}

wireframeBtn.addEventListener("click", () => {
  wireframe = !wireframe;
  wireframeBtn.classList.toggle("active", wireframe);
  applyWireframe();
});

// --- Editing (transform gizmo) -------------------------------------------------

async function populateNodeMaps(gltf: GLTF): Promise<void> {
  nodeByIndex.clear();
  indexByObject.clear();
  const nodes = (gltf.parser.json.nodes ?? []) as unknown[];
  for (let i = 0; i < nodes.length; i++) {
    const obj = (await gltf.parser.getDependency("node", i)) as THREE.Object3D;
    nodeByIndex.set(i, obj);
    indexByObject.set(obj, i);
  }
}

function resetGizmo(): void {
  gizmo.detach();
  selectedObject = null;
  selectedMaterial = null;
  gizmoEl.hidden = true;
  inspectorEl.hidden = true;
  nodeByIndex.clear();
  indexByObject.clear();
}

/** On gesture end, send one committed transform intent for the selected node. */
function commitTransform(): void {
  if (!selectedObject) return;
  const idx = indexByObject.get(selectedObject);
  if (idx === undefined) return;
  const p = selectedObject.position;
  const q = selectedObject.quaternion;
  const s = selectedObject.scale;
  send({
    type: "edit",
    edit: {
      nodeIndex: idx,
      translation: [p.x, p.y, p.z],
      rotation: [q.x, q.y, q.z, q.w],
      scale: [s.x, s.y, s.z],
    },
  });
}

/** Apply an authoritative transform from the host (undo/redo). */
function applyTransform(edit: TransformEdit): void {
  const obj = nodeByIndex.get(edit.nodeIndex);
  if (!obj) return;
  obj.position.set(edit.translation[0], edit.translation[1], edit.translation[2]);
  obj.quaternion.set(
    edit.rotation[0],
    edit.rotation[1],
    edit.rotation[2],
    edit.rotation[3]
  );
  obj.scale.set(edit.scale[0], edit.scale[1], edit.scale[2]);
  obj.updateMatrixWorld(true);
  if (highlight) highlight.update();
}

gizmoEl.querySelectorAll("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const mode = (btn as HTMLButtonElement).dataset.mode as
      | "translate"
      | "rotate"
      | "scale";
    gizmo.setMode(mode);
    gizmoEl
      .querySelectorAll("button")
      .forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
  });
});
gizmo.setMode("translate");
(
  gizmoEl.querySelector('[data-mode="translate"]') as HTMLElement | null
)?.classList.add("active");

// --- Inspector: material + extras ----------------------------------------------

function findMaterial(obj: THREE.Object3D): THREE.MeshStandardMaterial | null {
  let found: THREE.MeshStandardMaterial | null = null;
  obj.traverse((o) => {
    if (found) return;
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && mesh.material) {
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      if ((mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
        found = mat as THREE.MeshStandardMaterial;
      }
    }
  });
  return found;
}

function populateMaterialControls(mat: THREE.MeshStandardMaterial): void {
  matColor.value = "#" + mat.color.getHexString(THREE.SRGBColorSpace);
  matMetal.value = String(mat.metalness);
  matRough.value = String(mat.roughness);
}

/** Live preview during input — updates the three material only (no commit). */
function previewMaterial(): void {
  if (!selectedMaterial) return;
  selectedMaterial.color.setHex(
    parseInt(matColor.value.slice(1), 16),
    THREE.SRGBColorSpace
  );
  selectedMaterial.metalness = Number(matMetal.value);
  selectedMaterial.roughness = Number(matRough.value);
  renderMaterialInfo(selectedMaterial);
}

/** Commit on change — sends the intent to the host. */
function commitMaterial(): void {
  if (!selectedObject || !selectedMaterial) return;
  const idx = indexByObject.get(selectedObject);
  if (idx === undefined) return;
  const c = new THREE.Color().setHex(
    parseInt(matColor.value.slice(1), 16),
    THREE.SRGBColorSpace
  );
  send({
    type: "editMaterial",
    edit: {
      nodeIndex: idx,
      baseColorFactor: [c.r, c.g, c.b, 1],
      metallic: Number(matMetal.value),
      roughness: Number(matRough.value),
    },
  });
}

for (const el of [matColor, matMetal, matRough]) {
  el.addEventListener("input", previewMaterial);
  el.addEventListener("change", commitMaterial);
}

extrasApply.addEventListener("click", () => {
  if (!selectedObject) return;
  const idx = indexByObject.get(selectedObject);
  if (idx === undefined) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(extrasEl.value || "{}");
  } catch {
    extrasErr.textContent = "invalid JSON";
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    extrasErr.textContent = "must be an object";
    return;
  }
  extrasErr.textContent = "";
  const extras = parsed as Record<string, unknown>;
  selectedObject.userData = extras;
  send({ type: "editExtras", edit: { nodeIndex: idx, extras } });
});

/** Apply an authoritative material from the host (undo/redo). */
function applyMaterial(edit: MaterialEdit): void {
  const obj = nodeByIndex.get(edit.nodeIndex);
  if (!obj) return;
  const mat = findMaterial(obj);
  if (!mat) return;
  mat.color.setRGB(
    edit.baseColorFactor[0],
    edit.baseColorFactor[1],
    edit.baseColorFactor[2]
  );
  mat.metalness = edit.metallic;
  mat.roughness = edit.roughness;
  if (obj === selectedObject) {
    populateMaterialControls(mat);
    renderMaterialInfo(mat);
  }
}

/** Apply authoritative extras from the host (undo/redo). */
function applyExtras(edit: ExtrasEdit): void {
  const obj = nodeByIndex.get(edit.nodeIndex);
  if (!obj) return;
  obj.userData = edit.extras;
  if (obj === selectedObject) {
    extrasEl.value = JSON.stringify(edit.extras, null, 2);
    extrasErr.textContent = "";
  }
}

// --- Host channel --------------------------------------------------------------

window.addEventListener("message", (e: MessageEvent<HostToWebview>) => {
  const msg = e.data;
  if (msg.type === "load") {
    loadGlb(msg.uri);
  } else if (msg.type === "enrich") {
    cellSizeMetres = msg.enrichment?.cellSize ?? DEFAULT_CELL_SIZE_METRES;
    rebuildGrid();
    renderInfo(msg.enrichment);
  } else if (msg.type === "applyTransform") {
    applyTransform(msg.edit);
  } else if (msg.type === "applyMaterial") {
    applyMaterial(msg.edit);
  } else if (msg.type === "applyExtras") {
    applyExtras(msg.edit);
  }
});

send({ type: "ready", version: PROTOCOL_VERSION });
