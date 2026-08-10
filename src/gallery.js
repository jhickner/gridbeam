import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { buildBeamMesh } from "./beam.js";
import { buildPanelMesh, setPanelOpacityMode } from "./panel.js";
import { buildFixtureMesh, fixtureLabel } from "./fixtures.js";
import { buildBookMesh } from "./books.js";
import { beamTiltTransform, fmtIn } from "./grid.js";
import { computeBom } from "./bom.js";

// A file-preview gallery: reads Grid Beam JSON files, renders a thumbnail of
// each with the real mesh builders, and summarises what's inside. Used two
// ways — as the editor's import tool (mode "import", with selection) and as the
// standalone browser page (mode "browse").

const THUMB_W = 520, THUMB_H = 390;

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

// Same envelope handling as io.js: files have been written in three shapes over
// time — a bare doc, { doc, view }, and { name, doc, view }.
export function unpackFile(raw) {
  if (!raw) return { doc: null, view: null, name: null };
  if (Array.isArray(raw.objects)) return { doc: raw, view: null, name: null };
  if (raw.kind === "gridbeam-backup") return { doc: null, view: null, name: null, isBackup: true };
  return { doc: raw.doc || null, view: raw.view || null, name: raw.name || null };
}

// ------- Scene building (mirrors main.js's rebuildMeshes, minus interaction) -------

function meshBasePos(o) {
  if (o.type === "beam" && o.tilt) {
    const { offset } = beamTiltTransform(o.axis, o.tilt, o.length);
    return [o.pos[0] + offset[0], o.pos[1] + offset[1], o.pos[2] + offset[2]];
  }
  return o.pos.slice();
}

const buildMesh = (o) =>
  o.type === "beam" ? buildBeamMesh(o, undefined, false)
  : o.type === "fixture" ? buildFixtureMesh(o)
  : o.type === "book" ? buildBookMesh(o)
  : buildPanelMesh(o, false);

export function buildRoot(doc, meshById = null) {
  const root = new THREE.Group();

  const rotGroups = new Map();
  for (const o of doc.objects) {
    if (o.group && o.groupRotY && o.groupPivot) {
      if (!rotGroups.has(o.group)) {
        rotGroups.set(o.group, { rotY: o.groupRotY, pivot: o.groupPivot, members: [] });
      }
      rotGroups.get(o.group).members.push(o);
    }
  }

  const rotated = new Set();
  for (const [, rg] of rotGroups) {
    const wrapper = new THREE.Group();
    wrapper.position.set(rg.pivot[0], 0, rg.pivot[1]);
    wrapper.rotation.y = -rg.rotY * Math.PI / 180;
    for (const o of rg.members) {
      const g = buildMesh(o);
      const bp = meshBasePos(o);
      g.position.set(bp[0] - rg.pivot[0], bp[1], bp[2] - rg.pivot[1]);
      wrapper.add(g);
      if (meshById) meshById.set(o.id, g);
      rotated.add(o.id);
    }
    root.add(wrapper);
  }

  for (const o of doc.objects) {
    if (rotated.has(o.id)) continue;
    const g = buildMesh(o);
    root.add(g);
    if (meshById) meshById.set(o.id, g);
  }
  return root;
}

function disposeGroup(g) {
  g.traverse((c) => {
    if (c.geometry) c.geometry.dispose();
    if (c.material && c.material.userData && c.material.userData.disposable) c.material.dispose();
  });
}

export function addLights(scene) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x222222, 0.75));
  const d = new THREE.DirectionalLight(0xffffff, 0.85);
  d.position.set(40, 80, 30);
  scene.add(d);
}

// Frame the camera on a bounding box from a fixed three-quarter angle.
export function frame(camera, box, aspect, pad = 1.25) {
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 1);
  const fov = camera.fov * Math.PI / 180;
  const fitH = radius / Math.sin(fov / 2);
  const fitW = radius / Math.sin(Math.atan(Math.tan(fov / 2) * aspect));
  const dist = Math.max(fitH, fitW) * pad;
  camera.position.copy(center).addScaledVector(new THREE.Vector3(1, 0.62, 1).normalize(), dist);
  camera.near = Math.max(dist / 100, 0.1);
  camera.far = dist * 10;
  camera.updateProjectionMatrix();
  camera.lookAt(center);
  return center;
}

// ------- Thumbnails: one shared WebGL context for every card -------

let thumbRenderer = null;
function getThumbRenderer() {
  if (!thumbRenderer) {
    thumbRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    thumbRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    thumbRenderer.setSize(THUMB_W, THUMB_H);
    thumbRenderer.setClearColor(0x14181c, 1);
  }
  return thumbRenderer;
}

function renderThumb(doc) {
  const renderer = getThumbRenderer();
  const scene = new THREE.Scene();
  addLights(scene);
  const grid = new THREE.GridHelper(240, 160, 0x2a2a2a, 0x222222);
  scene.add(grid);

  const root = buildRoot(doc);
  scene.add(root);

  const box = new THREE.Box3().setFromObject(root);
  const camera = new THREE.PerspectiveCamera(40, THUMB_W / THUMB_H, 0.5, 4000);
  if (box.isEmpty()) { camera.position.set(40, 50, 60); camera.lookAt(0, 0, 0); }
  else frame(camera, box, THUMB_W / THUMB_H);

  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL("image/png");

  disposeGroup(root);
  grid.geometry.dispose();
  grid.material.dispose();
  return { url, box };
}

// ------- Summaries -------

function summarise(doc, box) {
  const counts = { beam: 0, panel: 0, fixture: 0, book: 0 };
  const fixtures = new Set();
  for (const o of doc.objects) {
    if (counts[o.type] === undefined) counts[o.type] = 0;
    counts[o.type]++;
    if (o.type === "fixture" && o.kind) fixtures.add(o.kind);
  }

  let dims = "—", footprint = 0;
  if (box && !box.isEmpty()) {
    const s = box.getSize(new THREE.Vector3());
    dims = `${fmtIn(s.x)} × ${fmtIn(s.z)} × ${fmtIn(s.y)} high`;
    footprint = s.x * s.y * s.z;
  }

  let lumber = null;
  try {
    const bom = computeBom(doc, { minimalMode: false });
    const totalIn = (bom.cuts || []).reduce((n, c) => n + c.length * c.qty, 0);
    if (totalIn > 0) lumber = `${Math.round(totalIn / 12)} ft of beam`;
  } catch { /* older docs may not satisfy the BOM's expectations */ }

  return {
    counts, dims, footprint, lumber,
    fixtures: [...fixtures].map(fixtureLabel),
    parts: doc.objects.length,
  };
}

// ------- The component -------

// mode "import" → checkboxes plus an "Import selected" footer.
// mode "browse" → click a card to open it full-screen.
export function createGallery({ mode = "browse", onImport, onOpenInEditor } = {}) {
  setPanelOpacityMode("opaque");
  const selectable = mode === "import";

  const el = document.createElement("div");
  el.className = "gb-gallery";
  el.innerHTML = `
    <div class="gb-gallery-bar">
      <button data-pick>Choose JSON files…</button>
      <input type="file" data-file accept="application/json" multiple hidden />
      <input type="search" data-search placeholder="Filter by name…" />
      <select data-sort>
        <option value="name">Sort: name</option>
        <option value="parts">Sort: most parts</option>
        <option value="size">Sort: largest</option>
      </select>
      ${selectable ? `<button data-all>Select all</button><button data-none>Clear</button>` : ""}
      <span data-count></span>
    </div>
    <div class="gb-gallery-drop" data-drop>
      <div>
        <h2>Drop Grid Beam JSON files here</h2>
        <p>…or click <strong>Choose JSON files…</strong> and select them all.</p>
        <p class="dim">Files are read locally in the browser. Nothing is uploaded.</p>
      </div>
    </div>
    <div class="gb-gallery-scroll" data-scroll hidden><div class="gb-gallery-grid" data-grid></div></div>
    ${selectable ? `
    <div class="gb-gallery-foot">
      <span data-selinfo>Nothing selected</span>
      <button data-import class="primary" disabled>Import selected</button>
    </div>` : ""}
    <div class="gb-gallery-lightbox" data-lightbox hidden>
      <div class="gb-gallery-lightbar">
        <strong data-lbtitle></strong>
        <span data-lbmeta></span>
        ${onOpenInEditor ? `<button data-lbopen>Open in editor</button>` : ""}
        <button data-lbclose>Close preview</button>
      </div>
      <div class="gb-gallery-lightcanvas" data-lbcanvas></div>
    </div>`;

  const q = (sel) => el.querySelector(sel);
  const gridEl = q("[data-grid]"), scrollEl = q("[data-scroll]"), dropEl = q("[data-drop]");
  const countEl = q("[data-count]"), searchEl = q("[data-search]"), sortEl = q("[data-sort]");
  const fileEl = q("[data-file]"), lightbox = q("[data-lightbox]"), lbCanvas = q("[data-lbcanvas]");

  let items = [];
  const selected = new Set();
  let lb = null;

  function cardHtml(it, i) {
    const s = it.summary;
    const bits = [];
    if (s.counts.beam) bits.push(`${s.counts.beam} beams`);
    if (s.counts.panel) bits.push(`${s.counts.panel} panels`);
    if (s.counts.book) bits.push(`${s.counts.book} books`);
    if (s.counts.fixture) bits.push(`${s.counts.fixture} fixtures`);
    const on = selected.has(i);

    return `
      <figure class="gb-card${on ? " selected" : ""}${it.doc ? "" : " broken"}" data-i="${i}">
        <div class="gb-card-thumb">
          <img src="${it.thumb}" alt="" />
          ${selectable && it.doc ? `<span class="gb-card-check">${on ? "✓" : ""}</span>` : ""}
          ${it.doc ? `<button class="gb-card-zoom" data-zoom="${i}" title="Preview">⤢</button>` : ""}
        </div>
        <figcaption>
          <div class="gb-card-title">${esc(it.title)}</div>
          <div class="gb-card-sub">${esc(it.file)}</div>
          <div class="gb-card-stats">${bits.join(" · ") || "empty"}</div>
          <div class="gb-card-dims">${esc(s.dims)}${s.lumber ? ` · ${esc(s.lumber)}` : ""}</div>
          ${s.fixtures.length ? `<div class="gb-card-fixtures">${esc(s.fixtures.join(", "))}</div>` : ""}
        </figcaption>
      </figure>`;
  }

  function paint() {
    const needle = searchEl.value.trim().toLowerCase();
    let view = items
      .map((it, i) => ({ it, i }))
      .filter(({ it }) => !needle ||
        it.title.toLowerCase().includes(needle) || it.file.toLowerCase().includes(needle));

    const mode2 = sortEl.value;
    view.sort((a, b) =>
      mode2 === "parts" ? b.it.summary.parts - a.it.summary.parts
      : mode2 === "size" ? b.it.summary.footprint - a.it.summary.footprint
      : a.it.file.localeCompare(b.it.file, undefined, { numeric: true }));

    gridEl.innerHTML = view.map(({ it, i }) => cardHtml(it, i)).join("");
    countEl.textContent = items.length ? `${view.length} of ${items.length}` : "";
    dropEl.hidden = items.length > 0;
    scrollEl.hidden = items.length === 0;

    if (selectable) {
      const n = selected.size;
      q("[data-selinfo]").textContent = n ? `${n} selected` : "Nothing selected";
      q("[data-import]").disabled = n === 0;
      q("[data-import]").textContent = n > 1 ? `Import ${n} projects` : "Import selected";
    }
  }

  function brokenItem(f, why) {
    return {
      file: f.name, title: f.name.replace(/\.json$/i, ""), doc: null,
      thumb: "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==",
      summary: { counts: {}, dims: why, footprint: -1, lumber: null, fixtures: [], parts: -1 },
    };
  }

  async function addFiles(fileList) {
    const files = [...fileList].filter((f) => /\.json$/i.test(f.name));
    if (!files.length) return;
    dropEl.hidden = true;
    scrollEl.hidden = false;
    countEl.textContent = `reading ${files.length}…`;

    for (const f of files) {
      let parsed;
      try { parsed = unpackFile(JSON.parse(await f.text())); }
      catch { items.push(brokenItem(f, "not valid JSON")); paint(); continue; }

      if (!parsed.doc || !Array.isArray(parsed.doc.objects)) {
        items.push(brokenItem(f, parsed.isBackup
          ? "whole-store backup — use Projects ▾ → Restore…"
          : "no Grid Beam objects"));
        paint();
        continue;
      }
      let thumb, box;
      try { ({ url: thumb, box } = renderThumb(parsed.doc)); }
      catch (e) { items.push(brokenItem(f, "couldn't render: " + e.message)); paint(); continue; }

      items.push({
        file: f.name,
        title: parsed.name || f.name.replace(/\.json$/i, ""),
        doc: parsed.doc,
        view: parsed.view,
        thumb,
        summary: summarise(parsed.doc, box),
      });
      paint();                                   // cards appear as they render
      await new Promise((r) => setTimeout(r, 0));
    }
    paint();
  }

  // ---- Preview ----

  function openPreview(it) {
    if (!it.doc) return;
    closePreview();

    q("[data-lbtitle]").textContent = it.title;
    q("[data-lbmeta]").textContent = `${it.summary.parts} parts · ${it.summary.dims} · ${it.file}`;
    lightbox.hidden = false;                     // unhide before measuring, or it's 0×0

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(lbCanvas.clientWidth, lbCanvas.clientHeight);
    renderer.setClearColor(0x14181c, 1);
    lbCanvas.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    addLights(scene);
    scene.add(new THREE.GridHelper(240, 160, 0x2a2a2a, 0x222222));
    const root = buildRoot(it.doc);
    scene.add(root);

    const camera = new THREE.PerspectiveCamera(45, lbCanvas.clientWidth / lbCanvas.clientHeight, 0.5, 4000);
    const box = new THREE.Box3().setFromObject(root);
    const center = box.isEmpty()
      ? (camera.position.set(40, 50, 60), new THREE.Vector3(0, 6, 0))
      : frame(camera, box, lbCanvas.clientWidth / lbCanvas.clientHeight, 1.15);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(center);
    controls.update();

    let alive = true;
    (function tick() {
      if (!alive) return;
      requestAnimationFrame(tick);
      controls.update();
      renderer.render(scene, camera);
    })();

    const onResize = () => {
      const w = lbCanvas.clientWidth, h = lbCanvas.clientHeight;
      camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    lb = { item: it, stop: () => {
      alive = false;
      window.removeEventListener("resize", onResize);
      controls.dispose();
      disposeGroup(root);
      renderer.dispose();
      renderer.domElement.remove();
    } };
  }

  function closePreview() {
    if (lb) { lb.stop(); lb = null; }
    lightbox.hidden = true;
  }

  // ---- Events ----

  q("[data-pick]").onclick = () => fileEl.click();
  fileEl.onchange = () => { addFiles(fileEl.files); fileEl.value = ""; };
  searchEl.oninput = paint;
  sortEl.onchange = paint;

  gridEl.addEventListener("click", (e) => {
    const zoom = e.target.closest("[data-zoom]");
    if (zoom) { e.stopPropagation(); openPreview(items[+zoom.dataset.zoom]); return; }

    const card = e.target.closest(".gb-card");
    if (!card) return;
    const i = +card.dataset.i;
    if (!items[i].doc) return;

    if (selectable) {
      selected.has(i) ? selected.delete(i) : selected.add(i);
      paint();
    } else {
      openPreview(items[i]);
    }
  });

  if (selectable) {
    q("[data-all]").onclick = () => {
      items.forEach((it, i) => { if (it.doc) selected.add(i); });
      paint();
    };
    q("[data-none]").onclick = () => { selected.clear(); paint(); };
    q("[data-import]").onclick = () => {
      const chosen = [...selected].sort((a, b) => a - b).map((i) => items[i]);
      if (chosen.length) onImport?.(chosen);
    };
  }

  q("[data-lbclose]").onclick = closePreview;
  const lbOpen = q("[data-lbopen]");
  if (lbOpen) lbOpen.onclick = () => { if (lb) onOpenInEditor?.(lb.item); };

  // Drag & drop anywhere over the gallery.
  for (const evt of ["dragenter", "dragover"]) {
    el.addEventListener(evt, (e) => { e.preventDefault(); el.classList.add("dragging-files"); });
  }
  el.addEventListener("dragleave", (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove("dragging-files");
  });
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("dragging-files");
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });

  paint();

  return {
    el,
    addFiles,
    openFilePicker: () => fileEl.click(),
    isPreviewOpen: () => !lightbox.hidden,
    closePreview,
    destroy: () => { closePreview(); el.remove(); },
  };
}
