import { contextBridge, ipcRenderer } from 'electron';
import type { DisplayPayload } from '../shared/api';

// The display window gets one read-only call. It never receives the organizer API.
contextBridge.exposeInMainWorld('openPlayDisplay', {
  getModel: (): Promise<DisplayPayload | null> => ipcRenderer.invoke('display:model'),
});
