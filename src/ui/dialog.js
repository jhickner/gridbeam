// Non-blocking <dialog> replacements for window.prompt / window.confirm, plus a
// transient toast.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

export function isDialogOpen() {
  return !!document.querySelector("dialog.gb-dialog[open]");
}

function open(html, wire) {
  const dlg = document.createElement("dialog");
  dlg.className = "gb-dialog";
  dlg.innerHTML = html;
  document.body.appendChild(dlg);

  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
      dlg.close();
    };
    dlg.addEventListener("close", () => { finish(null); dlg.remove(); });
    // Keep typing inside the dialog from reaching the app's window hotkeys.
    dlg.addEventListener("keydown", (e) => e.stopPropagation());
    wire(dlg, finish);
    dlg.showModal();
  });
}

const buttons = (confirmLabel, danger) => `
  <menu>
    <button type="button" data-cancel>Cancel</button>
    <button type="button" data-ok class="${danger ? "danger" : "primary"}">${esc(confirmLabel)}</button>
  </menu>`;

export function showPrompt({
  title = "",
  label = "",
  value = "",
  placeholder = "",
  confirmLabel = "OK",
  inputmode = "",
  validate,
} = {}) {
  return open(
    `<h4>${esc(title)}</h4>
     ${label ? `<label>${esc(label)}</label>` : ""}
     <input type="text" value="${esc(value)}" placeholder="${esc(placeholder)}"
            ${inputmode ? `inputmode="${esc(inputmode)}"` : ""} />
     <p class="gb-dialog-error" hidden></p>
     ${buttons(confirmLabel, false)}`,
    (dlg, finish) => {
      const input = dlg.querySelector("input");
      const err = dlg.querySelector(".gb-dialog-error");
      const submit = () => {
        const v = input.value.trim();
        const problem = validate ? validate(v) : null;
        if (problem) { err.textContent = problem; err.hidden = false; return; }
        finish(v);
      };
      dlg.querySelector("[data-ok]").onclick = submit;
      dlg.querySelector("[data-cancel]").onclick = () => finish(null);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); submit(); }
      });
      input.addEventListener("input", () => { err.hidden = true; });
      setTimeout(() => { input.focus(); input.select(); }, 0);
    }
  );
}

export function showConfirm({
  title = "",
  message = "",
  confirmLabel = "OK",
  danger = false,
} = {}) {
  return open(
    `<h4>${esc(title)}</h4>
     ${message ? `<p class="gb-dialog-msg">${esc(message)}</p>` : ""}
     ${buttons(confirmLabel, danger)}`,
    (dlg, finish) => {
      dlg.querySelector("[data-ok]").onclick = () => finish(true);
      dlg.querySelector("[data-cancel]").onclick = () => finish(false);
      setTimeout(() => dlg.querySelector("[data-ok]").focus(), 0);
    }
  ).then((v) => v === true);
}

// A confirm with more than two outcomes. Resolves to the chosen option's
// `value`, or null if dismissed.
export function showChoice({ title = "", message = "", options = [] } = {}) {
  return open(
    `<h4>${esc(title)}</h4>
     ${message ? `<p class="gb-dialog-msg">${esc(message)}</p>` : ""}
     <div class="gb-dialog-choices">
       ${options.map((o, i) => `
         <button type="button" data-choice="${i}" class="${o.danger ? "danger" : ""}">
           <span class="gb-choice-label">${esc(o.label)}</span>
           ${o.detail ? `<span class="gb-choice-detail">${esc(o.detail)}</span>` : ""}
         </button>`).join("")}
     </div>
     <menu><button type="button" data-cancel>Cancel</button></menu>`,
    (dlg, finish) => {
      dlg.querySelectorAll("[data-choice]").forEach((b) => {
        b.onclick = () => finish(options[+b.dataset.choice].value);
      });
      dlg.querySelector("[data-cancel]").onclick = () => finish(null);
    }
  );
}

let toastTimer = null;
export function showToast(message, { error = false } = {}) {
  let el = document.getElementById("gb-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "gb-toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.toggle("error", error);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}
