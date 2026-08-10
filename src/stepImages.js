import * as THREE from "three";
import { buildRoot, addLights, frame } from "./gallery.js";

// Renders one picture per assembly step: everything placed so far, with the
// part being added picked out in colour, from a camera fixed on the finished
// piece so the viewpoint never jumps between steps.
//
// Every mesh is built once and then shown or hidden per step — rebuilding the
// scene each time would be quadratic, and a 150-part design would crawl.

const HIGHLIGHT = 0xff9d2e;

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
  renderer.setClearColor(0x14181c, 1);

  const scene = new THREE.Scene();
  addLights(scene);
  const grid = new THREE.GridHelper(240, 160, 0x2a2a2a, 0x222222);
  scene.add(grid);

  const meshById = new Map();
  const root = buildRoot(doc, meshById);
  scene.add(root);

  // Frame on the finished piece, then hold that camera for every step.
  const camera = new THREE.PerspectiveCamera(40, W / H, 0.5, 4000);
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) { camera.position.set(40, 50, 60); camera.lookAt(0, 0, 0); }
  else frame(camera, box, W / H, 1.35);

  const highlightMat = new THREE.MeshStandardMaterial({
    color: HIGHLIGHT, roughness: 0.5, emissive: HIGHLIGHT, emissiveIntensity: 0.35,
  });

  for (const g of meshById.values()) g.visible = false;

  // Swap a part's materials for the highlight, remembering what to put back.
  const saved = [];
  const setHighlight = (id, on) => {
    const g = meshById.get(id);
    if (!g) return;
    if (on) {
      g.traverse((c) => {
        if (!c.isMesh) return;
        saved.push([c, c.material]);
        c.material = highlightMat;
      });
    } else {
      for (const [mesh, mat] of saved) mesh.material = mat;
      saved.length = 0;
    }
  };

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
    images.push(renderer.domElement.toDataURL("image/jpeg", quality));

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
  highlightMat.dispose();
  renderer.dispose();

  return images;
}
