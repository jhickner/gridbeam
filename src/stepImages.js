import * as THREE from "three";
import { buildRoot, addLights, frame } from "./gallery.js";

// Renders one picture per assembly step: everything placed so far, with the
// part being added picked out in colour, from a camera fixed on the finished
// piece so the viewpoint never jumps between steps.
//
// Every mesh is built once and then shown or hidden per step — rebuilding the
// scene each time would be quadratic, and a 150-part design would crawl.

// Diagram palette, chosen to survive a black-and-white printer: white paper,
// mid-grey for what is already built, near-black for the part going on now.
// The model's own wood and panel colours are dropped — in greyscale they all
// collapse to the same washed-out tone.
const PAPER = 0xffffff;
const PLACED = 0xcbcbcb;
const NEW_PART = 0x141414;
const GRID_MAJOR = 0xcfcfcf;
const GRID_MINOR = 0xe4e4e4;

// Big models get smaller frames: the images are inlined as data URLs, so the
// plan's file size is roughly steps × frame area.
function frameSize(stepCount) {
  if (stepCount > 110) return [300, 225];
  if (stepCount > 60) return [360, 270];
  return [440, 330];
}

// Async so a long run can yield to the event loop — 150+ frames takes about ten
// seconds, and blocking that long would freeze the editor with no feedback.
export async function renderAssemblySteps(doc, orderedIds, { quality = 0.72, onProgress = null } = {}) {
  const ids = orderedIds.filter(Boolean);
  if (!ids.length) return [];

  const [W, H] = frameSize(ids.length);
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H);
  renderer.setClearColor(PAPER, 1);

  const scene = new THREE.Scene();
  addLights(scene);
  const grid = new THREE.GridHelper(240, 160, GRID_MAJOR, GRID_MINOR);
  scene.add(grid);

  const meshById = new Map();
  const root = buildRoot(doc, meshById);
  scene.add(root);

  // Frame on the finished piece, then hold that camera for every step.
  const camera = new THREE.PerspectiveCamera(40, W / H, 0.5, 4000);
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) { camera.position.set(40, 50, 60); camera.lookAt(0, 0, 0); }
  else frame(camera, box, W / H, 1.35);

  const placedMat = new THREE.MeshStandardMaterial({ color: PLACED, roughness: 0.85 });
  const newMat = new THREE.MeshStandardMaterial({ color: NEW_PART, roughness: 0.7 });

  // Everything wears the flat diagram grey; only the part being added differs.
  for (const g of meshById.values()) {
    g.visible = false;
    g.traverse((c) => { if (c.isMesh) c.material = placedMat; });
  }

  const setHighlight = (id, on) => {
    const g = meshById.get(id);
    if (!g) return;
    g.traverse((c) => { if (c.isMesh) c.material = on ? newMat : placedMat; });
  };

  // The WebGL frame is composited onto a 2D canvas so a callout can be drawn
  // over the part being added — tone alone is not enough to find it on a
  // black-and-white print of a busy frame.
  const out = document.createElement("canvas");
  out.width = W; out.height = H;
  const ctx = out.getContext("2d");

  const corner = new THREE.Vector3();
  function screenRectOf(group) {
    const bb = new THREE.Box3().setFromObject(group);
    if (bb.isEmpty()) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      corner.set(
        i & 1 ? bb.max.x : bb.min.x,
        i & 2 ? bb.max.y : bb.min.y,
        i & 4 ? bb.max.z : bb.min.z
      ).project(camera);
      const px = (corner.x + 1) / 2 * W;
      const py = (1 - corner.y) / 2 * H;
      x0 = Math.min(x0, px); y0 = Math.min(y0, py);
      x1 = Math.max(x1, px); y1 = Math.max(y1, py);
    }
    return { x0, y0, x1, y1 };
  }

  // Dashed black box with a white halo, so it reads over light and dark alike.
  function drawCallout(r) {
    const pad = 7;
    const x = Math.max(1, r.x0 - pad), y = Math.max(1, r.y0 - pad);
    const w = Math.min(W - 2, r.x1 + pad) - x, h = Math.min(H - 2, r.y1 + pad) - y;
    if (!(w > 0 && h > 0)) return;
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 4;
    ctx.setLineDash([]);
    ctx.strokeRect(x, y, w, h);
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 4]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }

  const images = [];
  let previous = null;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const g = meshById.get(id);
    if (g) g.visible = true;
    if (previous) setHighlight(previous, false);
    setHighlight(id, true);
    previous = id;

    renderer.render(scene, camera);
    ctx.drawImage(renderer.domElement, 0, 0, W, H);
    if (g) {
      const r = screenRectOf(g);
      if (r) drawCallout(r);
    }
    images.push(out.toDataURL("image/jpeg", quality));

    if (onProgress && (i % 8 === 0 || i === ids.length - 1)) {
      onProgress(i + 1, ids.length);
      await new Promise((r) => setTimeout(r, 0)); // let the page paint
    }
  }
  if (previous) setHighlight(previous, false);

  root.traverse((c) => {
    if (c.geometry) c.geometry.dispose();
    if (c.material && c.material.userData && c.material.userData.disposable) c.material.dispose();
  });
  grid.geometry.dispose();
  grid.material.dispose();
  placedMat.dispose();
  newMat.dispose();
  renderer.dispose();

  return images;
}
