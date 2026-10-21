/// <reference types="vite/client" />
import type { OrganizerApi } from '../shared/api';

declare global {
  interface Window {
    openPlay: OrganizerApi;
  }
}

export {};
