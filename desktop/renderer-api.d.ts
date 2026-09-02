import type { SloppyPotatoDesktopApi } from "./shared/contracts";

declare global {
  interface Window {
    /** Present only inside the signed Sloppy Potato desktop shell. */
    sloppyPotatoDesktop?: SloppyPotatoDesktopApi;
  }
}

export {};
