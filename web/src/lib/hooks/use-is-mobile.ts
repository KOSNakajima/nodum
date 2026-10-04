"use client";

/** Viewport < 768px → mobile layout (drawer sidebars, top bar). */

import { useSyncExternalStore } from "react";

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export function useIsMobile(): boolean {
  return useMedia("(max-width: 767px)");
}

/** A finger, not a mouse — phones AND tablets. For gestures that fight touch
 *  (long-press menus over text, drag-and-drop), not for layout. */
export function useCoarsePointer(): boolean {
  return useMedia("(pointer: coarse)");
}
