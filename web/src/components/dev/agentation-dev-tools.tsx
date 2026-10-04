"use client";

/**
 * Agentation (https://github.com/benjitaylor/agentation): a dev-only visual
 * feedback toolbar. Click elements on the running app, annotate them, and it
 * produces structured markdown (selectors, React component hierarchy, source
 * locations) to paste into an AI coding agent.
 *
 * The NODE_ENV check is evaluated at build time, so the module-scope
 * conditional prunes the entire package from production bundles — prod ships
 * zero agentation bytes. (License: PolyForm Shield — fine as an internal dev
 * tool; it is a devDependency and never redistributed.)
 */

import dynamic from "next/dynamic";
import { useEffect } from "react";

const Agentation =
  process.env.NODE_ENV === "development"
    ? dynamic(() => import("agentation").then((m) => m.Agentation), { ssr: false })
    : null;

/**
 * Without `endpoint` the toolbar keeps annotations in localStorage only, which
 * means copy-pasting markdown into the agent by hand. Pointing it at the
 * agentation MCP server (stdio for the agent, HTTP on 4747 for the browser)
 * closes the loop: the agent reads pending annotations itself. The server is
 * registered per-developer (`claude mcp add --scope local agentation --
 * npx --prefer-offline -y agentation-mcp server`; --prefer-offline skips the
 * registry round trip that otherwise makes a network blip time the server out
 * at session start). When it is not running the toolbar just falls back to
 * localStorage — nothing to guard here. `npx agentation-mcp doctor` checks it.
 */
const AGENTATION_ENDPOINT = "http://localhost:4747";

/**
 * At phone widths the toolbar's default corner (20px from the bottom) sits on
 * the workspace's bottom nav bar and on the keyboard toolbar. Agentation draws
 * inside its own shadow root, which page CSS cannot reach, so the override is
 * put in there. Only the default spot moves: once dragged, the toolbar is
 * positioned by inline left/top (persisted by Agentation) and left alone.
 */
const PHONE_OFFSET_CSS = `
@media (max-width: 767px) {
  [data-agentation-toolbar]:not([style*="top"]) {
    bottom: calc(64px + env(safe-area-inset-bottom)) !important;
  }
}`;

function useAgentationPhoneOffset() {
  useEffect(() => {
    if (!Agentation) return;
    const apply = () => {
      const root = document.querySelector("agentation-toolbar")?.shadowRoot;
      if (!root) return false;
      if (!root.querySelector("style[data-nodum-phone-offset]")) {
        const style = document.createElement("style");
        style.dataset.nodumPhoneOffset = "";
        style.textContent = PHONE_OFFSET_CSS;
        root.appendChild(style);
      }
      return true;
    };
    if (apply()) return;
    // The toolbar is loaded lazily and mounts after us.
    const observer = new MutationObserver(() => {
      if (apply()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
}

export function AgentationDevTools() {
  // Also at phone widths: the mobile layout is annotated as much as desktop.
  useAgentationPhoneOffset();
  if (!Agentation) return null;
  return <Agentation endpoint={AGENTATION_ENDPOINT} />;
}
