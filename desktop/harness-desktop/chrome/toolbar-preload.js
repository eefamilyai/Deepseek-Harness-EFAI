// The only privileged surface the toolbar renderer can reach.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dshToolbar", {
  getState: () => ipcRenderer.invoke("dsh-toolbar:get-state"),
  back: () => ipcRenderer.invoke("dsh-toolbar:back"),
  forward: () => ipcRenderer.invoke("dsh-toolbar:forward"),
  reload: () => ipcRenderer.invoke("dsh-toolbar:reload"),
  navigate: (url) => ipcRenderer.invoke("dsh-toolbar:navigate", url),
  onState: (handler) => {
    ipcRenderer.on("dsh-toolbar:state", (_event, state) => handler(state));
  },
});
