import { contextBridge, ipcRenderer } from 'electron';
import { API_METHODS, type ApiMethod, type OrganizerApi } from '../shared/api';

// Expose only the whitelisted organizer API; the renderer never sees Node or Electron.
const api = {} as Record<ApiMethod, (...args: unknown[]) => Promise<unknown>>;
for (const method of API_METHODS) {
  api[method] = (...args: unknown[]) => ipcRenderer.invoke(`api:${method}`, ...args);
}

contextBridge.exposeInMainWorld('openPlay', api as unknown as OrganizerApi);
