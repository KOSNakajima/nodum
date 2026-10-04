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

import { useIsMobile } from "@/lib/hooks/use-is-mobile";

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

export function AgentationDevTools() {
  // Agentation is desktop-only, and at phone widths its floating button sits
  // on the bottom nav bar and the keyboard toolbar.
  const isMobile = useIsMobile();
  if (!Agentation || isMobile) return null;
  return <Agentation endpoint={AGENTATION_ENDPOINT} />;
}
