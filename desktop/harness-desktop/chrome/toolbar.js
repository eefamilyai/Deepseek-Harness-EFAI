// Toolbar renderer. contextIsolation is on, so every privileged action goes
// through the contextBridge surface installed by toolbar-preload.js.
const urlInput = document.getElementById("url");
const statusEl = document.getElementById("status");
const back = document.getElementById("back");
const forward = document.getElementById("forward");
const reload = document.getElementById("reload");

const api = window.dshToolbar;

function load(entry) {
  if (!entry) return;
  urlInput.value = entry.url === "about:blank" ? "" : entry.url;
  back.disabled = !entry.canGoBack;
  forward.disabled = !entry.canGoForward;
  statusEl.textContent = entry.isLoading ? "loading" : "";
}

api.onState(load);
api.getState().then(load);

back.addEventListener("click", () => api.back());
forward.addEventListener("click", () => api.forward());
reload.addEventListener("click", () => api.reload());

urlInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  const raw = urlInput.value.trim();
  if (!raw) return;
  api.navigate(raw);
  urlInput.blur();
});
