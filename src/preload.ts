import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("mascot", {
  setIgnoreMouse: (ignore: boolean) => ipcRenderer.send("set-ignore-mouse", ignore),
  dragMove: (dx: number, dy: number) => ipcRenderer.send("drag-move", dx, dy),
  dragEnd: () => ipcRenderer.send("drag-end"),
  walkStep: (dx: number): Promise<boolean> => ipcRenderer.invoke("walk-step", dx),
  walkEnd: () => ipcRenderer.send("walk-end"),
  onSay: (cb: (text: string, ms?: number) => void) =>
    ipcRenderer.on("say", (_e, text: string, ms?: number) => cb(text, ms)),
});
