"use client";

/**
 * The lines selected in the editor, for the AI panel — "fix these lines".
 *
 * Not persisted and not part of the workspace store: it changes on every
 * selection, and a selection from a previous session means nothing. CodeMirror
 * keeps its selection when focus moves to the chat box, so this does too; it is
 * cleared only when the selection collapses or that note's editor goes away.
 */

import { create } from "zustand";

export interface EditorSelection {
  noteId: string;
  /** 1-based, inclusive. */
  fromLine: number;
  toLine: number;
  text: string;
}

interface EditorSelectionState {
  selection: EditorSelection | null;
  /** Replace the selection for `noteId`; `null` clears it if it is that note's. */
  report: (noteId: string, lines: Omit<EditorSelection, "noteId"> | null) => void;
}

export const useEditorSelectionStore = create<EditorSelectionState>((set) => ({
  selection: null,
  report: (noteId, lines) =>
    set((s) => {
      if (lines) return { selection: { noteId, ...lines } };
      return s.selection?.noteId === noteId ? { selection: null } : s;
    }),
}));
