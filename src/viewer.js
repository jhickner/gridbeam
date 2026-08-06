import { createGallery } from "./gallery.js";
import { createProject } from "./io.js";

// Standalone browse page. Same gallery component the editor's import tool uses,
// in "browse" mode: click a card to look at it, then hand it to the editor.
const gallery = createGallery({
  mode: "browse",
  onOpenInEditor: (it) => {
    const name = createProject(it.title, it.doc, it.view);
    localStorage.setItem("gridbeam.currentProject", name);
    location.href = "index.html";
  },
});

document.getElementById("gallery-mount").appendChild(gallery.el);
