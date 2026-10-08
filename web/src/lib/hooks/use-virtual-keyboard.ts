"use client";

/**
 * The on-screen keyboard, as far as a web page can see it.
 *
 * `open` — a text field or the editor has focus on a touch device (the only
 * signal that works on both iOS and Android; neither reports the keyboard
 * itself). `inset` — how much of the layout viewport the keyboard covers.
 * Android honours `interactive-widget=resizes-content`, so the layout already
 * shrank and this is 0; iOS Safari does not, so it is the gap between the
 * layout viewport and the visual one. Pin keyboard toolbars at `bottom: inset`.
 */

import { useSyncExternalStore } from "react";

type Snapshot = { open: boolean; inset: number };

const CLOSED: Snapshot = { open: false, inset: 0 };
let current: Snapshot = CLOSED;

function editableFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly;
  if (el instanceof HTMLInputElement) {
    return !el.readOnly && !["checkbox", "radio", "range", "button", "submit", "file", "color"].includes(el.type);
  }
  return false;
}

function read(): Snapshot {
  if (!window.matchMedia("(pointer: coarse)").matches) return CLOSED;
  const vv = window.visualViewport;
  const inset = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
  const open = editableFocused();
  // Same object while nothing changed — useSyncExternalStore compares by identity.
  if (open === current.open && inset === current.inset) return current;
  current = { open, inset: open ? inset : 0 };
  return current;
}

function subscribe(onChange: () => void): () => void {
  const vv = window.visualViewport;
  // focusout fires before focus lands on the next field; let it settle.
  const later = () => requestAnimationFrame(onChange);
  vv?.addEventListener("resize", onChange);
  vv?.addEventListener("scroll", onChange);
  document.addEventListener("focusin", onChange);
  document.addEventListener("focusout", later);
  return () => {
    vv?.removeEventListener("resize", onChange);
    vv?.removeEventListener("scroll", onChange);
    document.removeEventListener("focusin", onChange);
    document.removeEventListener("focusout", later);
  };
}

export function useVirtualKeyboard(): Snapshot {
  return useSyncExternalStore(subscribe, read, () => CLOSED);
}
