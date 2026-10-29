import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("veil", {
  command: (operation: string, input?: unknown) =>
    ipcRenderer.invoke("veil:command", operation, input),
  subscribe: (handler: (state: unknown) => void) => {
    const listener = (_event: unknown, state: unknown) => handler(state);
    ipcRenderer.on("veil:state", listener);
    return () => ipcRenderer.removeListener("veil:state", listener);
  },
  onAsk: (handler: (value: unknown) => void) => {
    const listener = (_event: unknown, value: unknown) => handler(value);
    ipcRenderer.on("veil:ask", listener);
    return () => ipcRenderer.removeListener("veil:ask", listener);
  },
  onAskExpired: (handler: (value: unknown) => void) => {
    const listener = (_event: unknown, value: unknown) => handler(value);
    ipcRenderer.on("veil:ask-expired", listener);
    return () => ipcRenderer.removeListener("veil:ask-expired", listener);
  },
});
