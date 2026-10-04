"use client";

/**
 * Default location for new notes (S11.3) — vault setting, Obsidian's
 * "Files & links → Default location for new notes".
 *
 *   newNoteLocation: "root" (default) | "current" | "folder"
 *   newNoteFolder:   slash path used when location is "folder"
 *
 * Applies to ⌘N, quick-switcher create, and wikilink ghost-create (unless the
 * link target carries its own path).
 */

import type { QueryClient } from "@tanstack/react-query";

import { ApiError } from "@/lib/api/client";
import { noteApi } from "@/lib/api/endpoints";
import type { Note, Vault } from "@/lib/api/types";
import { useWorkspaceStore } from "@/lib/stores/workspace-store";

export type NewNoteLocation = "root" | "current" | "folder";

/** Folder path (no trailing slash) new notes should land in; undefined = root. */
export function resolveNewNoteFolder(
  queryClient: QueryClient,
  vaultId: string,
  /** Path of the note the user is working in, if the caller knows it. */
  currentNotePath?: string,
): string | undefined {
  const vaults = queryClient.getQueryData<Vault[]>(["vaults"]);
  const settings = (vaults?.find((v) => v.id === vaultId)?.settings ?? {}) as Record<
    string,
    unknown
  >;
  const location = (settings.newNoteLocation as NewNoteLocation) ?? "root";

  if (location === "folder") {
    const folder = String(settings.newNoteFolder ?? "")
      .trim()
      .replace(/^\/+|\/+$/g, "");
    return folder || undefined;
  }

  if (location === "current") {
    const path = currentNotePath ?? getActiveNotePath(queryClient, vaultId);
    if (!path) return undefined;
    const idx = path.lastIndexOf("/");
    return idx > 0 ? path.slice(0, idx) : undefined;
  }

  return undefined;
}

function getActiveNotePath(queryClient: QueryClient, vaultId: string): string | undefined {
  const { panes, activePane } = useWorkspaceStore.getState();
  const pane = panes[activePane];
  const tab = pane?.tabs.find((t) => t.id === pane.activeTabId && t.kind === "note");
  if (!tab) return undefined;
  return queryClient.getQueryData<Note>(["note", vaultId, tab.id])?.path;
}

/**
 * Create a blank note named the way Obsidian names one — "Untitled", then
 * "Untitled 1", "Untitled 2", … taking the first free name in the target
 * folder. (A timestamp title used to be generated here, but its "HH:MM" put a
 * ":" in the name, which note names may not contain: every create was a 422.)
 */
export async function createUntitledNote(vaultId: string, folderPath?: string): Promise<Note> {
  for (let n = 0; n < 1000; n++) {
    try {
      return await noteApi.create(vaultId, {
        title: n === 0 ? "Untitled" : `Untitled ${String(n)}`,
        folder_path: folderPath,
      });
    } catch (err) {
      // 409 = that name is taken in this folder; anything else is real.
      if (err instanceof ApiError && err.status === 409) continue;
      throw err;
    }
  }
  throw new Error("Could not find a free “Untitled” name.");
}
