/// <reference types="vite/client" />

import type { WhisperWebApi } from '../shared/api';

declare global {
  interface Window {
    whisperWeb: WhisperWebApi;
  }
}

export {};
