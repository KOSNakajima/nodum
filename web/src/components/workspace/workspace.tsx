"use client";

/** Workspace — the Obsidian-style application frame. */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";

import { EditorPane } from "./editor-pane";

// WebGL2 + 144kB gz — never in the shared bundle, never SSR'd.
const GraphView = dynamic(
  () => import("@/components/graph/graph-view").then((m) => m.GraphView),
  { ssr: false, loading: () => <GraphLoading /> },
);

function GraphLoading() {
  return (
    <div className="flex h-full items-center justify-center text-[13px] text-ob-faint">
      Loading graph…
    </div>
  );
}
import { CommandPalette } from "./command-palette";
import { ConnectionCallbackNotice } from "./connection-callback-notice";
import { ImportDialog } from "@/components/import/import-dialog";
import { SyncProgressCard } from "@/components/import/sync-progress-card";
import { QuickSwitcher } from "./quick-switcher";
import { Ribbon } from "./ribbon";
import { SettingsModal } from "./settings-modal";
import { SidebarLeft } from "./sidebar-left";
import { SidebarRight } from "./sidebar-right";
import { PaneDropOverlay } from "./pane-drop-overlay";
import { StatusBar } from "./status-bar";
import { TabBar } from "./tab-bar";
import { cn } from "@/lib/utils";
import { CanvasView } from "@/components/canvas/canvas-view";
import { TemplatePicker } from "./template-picker";
import { Toaster } from "./toaster";
import { dailyApi, noteApi } from "@/lib/api/endpoints";
import type { Vault } from "@/lib/api/types";
import { api } from "@/lib/api/client";
import { toastError, useToastStore } from "@/lib/stores/toast-store";
import { Sheet } from "@/components/ui/sheet";
import { MobileMenu, MobileNavBar, MobileTabSwitcher, MobileTopBar } from "./mobile-chrome";

import { ConfirmDialog, confirmDelete } from "./confirm-dialog";
import { DemoWorkspaceOffer } from "./demo-workspace-offer";
import { OnboardingTour } from "./onboarding-tour";
import { FONT_CHOICES, useEditorSettings, useUserPrefs } from "@/lib/hooks/use-editor-settings";
import { useIsMobile } from "@/lib/hooks/use-is-mobile";
import { useVirtualKeyboard } from "@/lib/hooks/use-virtual-keyboard";
import { createUntitledNote, resolveNewNoteFolder } from "@/lib/new-note-location";
import { usePlugins } from "@/lib/plugins/use-plugins";
import { useDocumentTitle } from "@/lib/hooks/use-document-title";
import { useWorkspaceStore } from "@/lib/stores/workspace-store";

export function Workspace({ vault }: { vault: Vault }) {
  const queryClient = useQueryClient();
  const panes = useWorkspaceStore((s) => s.panes);
  const activePane = useWorkspaceStore((s) => s.activePane);
  const openTab = useWorkspaceStore((s) => s.openTab);
  const openNoteBeside = useWorkspaceStore((s) => s.openNoteBeside);
  const setGraphFocus = useWorkspaceStore((s) => s.setGraphFocus);
  const graphFocusNoteId = useWorkspaceStore((s) => s.graphFocusNoteId);
  const setActivePane = useWorkspaceStore((s) => s.setActivePane);
  const setSwitcherOpen = useWorkspaceStore((s) => s.setSwitcherOpen);
  const switcherOpen = useWorkspaceStore((s) => s.switcherOpen);

  const splitRatio = useWorkspaceStore((s) => s.splitRatio);
  const setSplitRatio = useWorkspaceStore((s) => s.setSplitRatio);
  const splitOrientation = useWorkspaceStore((s) => s.splitOrientation);
  const mainRef = useRef<HTMLElement>(null);
  const isColumnSplit = splitOrientation === "column";

  const isMobile = useIsMobile();
  const ribbonVisible = useWorkspaceStore((s) => s.ribbonVisible);

  // Drag the seam between split panes; ratio follows the cursor (along the
  // split axis), store clamps.
  const onSplitDragStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const el = mainRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const column = useWorkspaceStore.getState().splitOrientation === "column";
      const prevSelect = document.body.style.userSelect;
      document.body.style.userSelect = "none";
      document.body.style.cursor = column ? "row-resize" : "col-resize";
      const onMove = (ev: PointerEvent) =>
        setSplitRatio(
          column ? (ev.clientY - rect.top) / rect.height : (ev.clientX - rect.left) / rect.width,
        );
      const onUp = () => {
        document.body.style.userSelect = prevSelect;
        document.body.style.cursor = "";
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [setSplitRatio],
  );
  // Phone drawers live in the store: a tag tapped in the right drawer has to
  // be able to swap to the left one (its search pane).
  const mobileDrawer = useWorkspaceStore((s) => s.mobileDrawer);
  const setMobileDrawer = useWorkspaceStore((s) => s.setMobileDrawer);
  const [mobileTabsOpen, setMobileTabsOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const keyboard = useVirtualKeyboard();
  // Crossing the phone breakpoint (rotation, window resize) starts with both
  // drawers shut — desktop pane picks also set mobileDrawer, and must not
  // pop a drawer open the next time the phone layout applies.
  useEffect(() => {
    useWorkspaceStore.getState().setMobileDrawer(null);
  }, [isMobile]);

  // Swipe in from a screen edge opens that side's drawer (Obsidian mobile).
  // Never while typing: there the gesture is selecting text.
  const edgeSwipe = useRef<{ id: number; x: number; y: number; side: "left" | "right" } | null>(null);
  const onEdgePointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== "touch" || keyboard.open) return;
    const edge = 24;
    const side = e.clientX <= edge ? "left" : e.clientX >= window.innerWidth - edge ? "right" : null;
    edgeSwipe.current = side ? { id: e.pointerId, x: e.clientX, y: e.clientY, side } : null;
  };
  const onEdgePointerMove = (e: React.PointerEvent) => {
    const s = edgeSwipe.current;
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    const dy = Math.abs(e.clientY - s.y);
    if (dy > 30) edgeSwipe.current = null;
    else if ((s.side === "left" && dx > 40) || (s.side === "right" && dx < -40)) {
      edgeSwipe.current = null;
      setMobileDrawer(s.side);
    }
  };

  // Mirror the user's "default view for new tabs" pref into the store so
  // openTab can apply it without reaching into React state.
  const defaultViewMode = useEditorSettings().defaultViewMode;
  useEffect(() => {
    useWorkspaceStore.getState().setDefaultEditorMode(defaultViewMode);
  }, [defaultViewMode]);

  // Appearance (S11.3 + S15.1) — accent + font overrides, on boot and live.
  const prefs = useUserPrefs();
  const { accentColor, fontInterface, fontText, fontMonospace, showRibbon } = prefs;
  useEffect(() => {
    const root = document.documentElement;
    if (accentColor) {
      root.style.setProperty("--ob-interactive-accent", accentColor);
      root.style.setProperty(
        "--ob-interactive-accent-hover",
        `color-mix(in srgb, ${accentColor} 85%, white)`,
      );
    } else {
      root.style.removeProperty("--ob-interactive-accent");
      root.style.removeProperty("--ob-interactive-accent-hover");
    }
    // Fonts: an empty stack (default) removes the override → globals.css wins
    const setFont = (varName: string, key: keyof typeof FONT_CHOICES) => {
      const stack = FONT_CHOICES[key];
      if (stack) root.style.setProperty(varName, stack);
      else root.style.removeProperty(varName);
    };
    setFont("--font-interface", fontInterface);
    setFont("--font-text", fontText);
    setFont("--font-monospace", fontMonospace);
    return () => {
      root.style.removeProperty("--ob-interactive-accent");
      root.style.removeProperty("--ob-interactive-accent-hover");
    };
  }, [accentColor, fontInterface, fontText, fontMonospace]);

  // Ribbon visibility lives on the user (cross-device); mirror into the store.
  useEffect(() => {
    useWorkspaceStore.setState({ ribbonVisible: showRibbon });
  }, [showRibbon]);

  // Switching vault opens a NEW browser tab, so the tab title has to say which
  // vault — two open vaults are otherwise indistinguishable in the tab strip.
  useDocumentTitle(`${vault.name} — Nodum`);

  const currentPane = panes[activePane] ?? panes[0];
  const activeTab = currentPane.tabs.find((t) => t.id === currentPane.activeTabId) ?? null;
  const activeNoteId = activeTab?.kind === "note" ? activeTab.id : null;

  const openNote = useCallback(
    (noteId: string, title: string, opts?: { inCurrentTab?: boolean }) => {
      // Obsidian: a click in the explorer reads the note in the current tab
      // (a pinned one is never taken over); ⌘-click, panels and new notes
      // open another tab.
      openTab({ id: noteId, kind: "note", title }, { replace: opts?.inCurrentTab === true });
      // The open note is the one the graph accents as "selected".
      setGraphFocus(noteId);
      setMobileDrawer(null);
    },
    [openTab, setGraphFocus, setMobileDrawer],
  );

  // Keep the graph's "note you are working in" on whatever note is actually
  // showing — switching tabs and Back/Forward change it just as much as opening
  // one does. Never cleared: moving into the graph pane itself leaves
  // activeNoteId null, and the note you came from is still the one you are on.
  useEffect(() => {
    if (activeNoteId) setGraphFocus(activeNoteId);
  }, [activeNoteId, setGraphFocus]);

  // "Open in new window" navigates to /vault/{id}?note={noteId}; without this
  // the new window opened the vault and ignored the note entirely.
  const openedFromUrl = useRef(false);
  useEffect(() => {
    if (openedFromUrl.current) return;
    const wanted = new URLSearchParams(window.location.search).get("note");
    if (!wanted) return;
    openedFromUrl.current = true;
    void (async () => {
      try {
        const note = await noteApi.get(vault.id, wanted);
        openTab({ id: note.id, kind: "note", title: note.title });
        setGraphFocus(note.id);
      } catch {
        // A stale or foreign id should not break the workspace — just ignore it.
      } finally {
        // Drop the param so a reload doesn't force the note back open.
        window.history.replaceState(null, "", `/vault/${vault.id}`);
      }
    })();
  }, [vault.id, openTab, setGraphFocus]);

  const openGraph = useCallback(() => {
    // The whole vault: opening the graph from anywhere but a folder's own
    // graph button drops a folder scope left over from earlier.
    useWorkspaceStore.getState().setGraphFolder(null);
    openTab({ id: "graph", kind: "graph", title: "Graph view" });
  }, [openTab]);

  const createFromGraph = useCallback(
    (title: string) => {
      void (async () => {
        try {
          const created = await noteApi.create(vault.id, {
            title,
            folder_path: resolveNewNoteFolder(queryClient, vault.id),
          });
          void queryClient.invalidateQueries({ queryKey: ["tree", vault.id] });
          void queryClient.invalidateQueries({ queryKey: ["graph", vault.id] });
          openNote(created.id, created.title);
        } catch (err) {
          toastError(err, "Could not create note.");
        }
      })();
    },
    [vault.id, queryClient, openNote],
  );

  const newNote = useMutation({
    mutationFn: () => createUntitledNote(vault.id, resolveNewNoteFolder(queryClient, vault.id)),
    onSuccess: (note) => {
      void queryClient.invalidateQueries({ queryKey: ["tree", vault.id] });
      void queryClient.invalidateQueries({ queryKey: ["graph", vault.id] });
      openNote(note.id, note.title);
    },
    // A failed create used to do nothing at all — the button looked dead.
    onError: (err) => toastError(err, "Could not create note."),
  });

  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  // In the store, not local state: the vault switcher and (later) the AI panel
  // open settings straight to a named tab from far outside this component.
  const settingsOpen = useWorkspaceStore((s) => s.settingsOpen);
  const setSettingsOpen = useWorkspaceStore((s) => s.setSettingsOpen);
  const importInputRef = useRef<HTMLInputElement>(null);
  const { commands: pluginCommands, runCommand: runPluginCommand } = usePlugins(vault.id, { run: true });
  const importFolderRef = useRef<HTMLInputElement>(null);
  const importOpen = useWorkspaceStore((s) => s.importOpen);
  const setImportOpen = useWorkspaceStore((s) => s.setImportOpen);

  const exportVault = useCallback(() => {
    // Same-origin proxy carries the cookie; access token not needed for a download
    window.open(`/api/v1/vaults/${vault.id}/export`, "_blank");
  }, [vault.id]);

  const importVault = useCallback(
    (file: File) => {
      void (async () => {
        try {
          const form = new FormData();
          form.append("file", file);
          const stats = await api<{ imported: number; renamed: number }>(
            `/vaults/${vault.id}/import`,
            { method: "POST", body: form },
          );
          void queryClient.invalidateQueries({ queryKey: ["tree", vault.id] });
          void queryClient.invalidateQueries({ queryKey: ["graph", vault.id] });
          void queryClient.invalidateQueries({ queryKey: ["tags", vault.id] });
          useToastStore.getState().push(
            `Imported ${String(stats.imported)} notes` +
              (stats.renamed ? ` (${String(stats.renamed)} renamed)` : ""),
            "info",
          );
        } catch (err) {
          toastError(err, "Import failed.");
        }
      })();
    },
    [vault.id, queryClient],
  );

  /** Import a picked folder (or loose files) — no zipping required. Each file
   *  is sent with its vault-relative path so the server rebuilds the tree. */
  const importFolder = useCallback(
    (files: FileList) => {
      void (async () => {
        const picked = [...files].filter((f) => f.size > 0);
        if (picked.length === 0) return;
        const toastId = useToastStore
          .getState()
          .push(`Importing ${String(picked.length)} files…`, "info");
        try {
          const form = new FormData();
          for (const file of picked) {
            // webkitRelativePath carries "MyVault/Notes/x.md"; fall back to the
            // bare name when loose files are picked instead of a folder.
            form.append("files", file, file.webkitRelativePath || file.name);
          }
          const stats = await api<{
            imported: number;
            renamed: number;
            imported_attachments: number;
            imported_pdf_notes: number;
          }>(`/vaults/${vault.id}/import-files`, { method: "POST", body: form });
          void queryClient.invalidateQueries({ queryKey: ["tree", vault.id] });
          void queryClient.invalidateQueries({ queryKey: ["graph", vault.id] });
          void queryClient.invalidateQueries({ queryKey: ["tags", vault.id] });
          const bits = [`Imported ${String(stats.imported)} notes`];
          if (stats.imported_pdf_notes) bits.push(`${String(stats.imported_pdf_notes)} from PDFs`);
          if (stats.imported_attachments) bits.push(`${String(stats.imported_attachments)} attachments`);
          if (stats.renamed) bits.push(`${String(stats.renamed)} renamed`);
          useToastStore.getState().push(bits.join(" · "), "info");
        } catch (err) {
          toastError(err, "Import failed.");
        } finally {
          useToastStore.getState().dismiss(toastId);
        }
      })();
    },
    [vault.id, queryClient],
  );

  const openDailyNote = useCallback(() => {
    void (async () => {
      try {
        const note = await dailyApi.openDailyNote(vault.id);
        void queryClient.invalidateQueries({ queryKey: ["tree", vault.id] });
        void queryClient.invalidateQueries({ queryKey: ["graph", vault.id] });
        openNote(note.id, note.title);
      } catch (err) {
        toastError(err, "Could not open today's daily note.");
      }
    })();
  }, [vault.id, queryClient, openNote]);

  const closeActiveTab = useCallback(() => {
    const { panes: all, activePane: idx } = useWorkspaceStore.getState();
    const current = all[idx]?.activeTabId;
    if (current) closeTab(current, idx);
  }, [closeTab]);

  const deleteActiveNote = useCallback(() => {
    const { panes: all, activePane: idx } = useWorkspaceStore.getState();
    const current = all[idx]?.activeTabId;
    const tab = all[idx]?.tabs.find((t) => t.id === current && t.kind === "note");
    if (!tab) return;
    void (async () => {
      try {
        if (!(await confirmDelete(`Delete “${tab.title}”?`))) return;
        await noteApi.remove(vault.id, tab.id);
        closeTab(tab.id);
        void queryClient.invalidateQueries({ queryKey: ["tree", vault.id] });
        void queryClient.invalidateQueries({ queryKey: ["graph", vault.id] });
      } catch (err) {
        toastError(err, "Could not delete note.");
      }
    })();
  }, [vault.id, closeTab, queryClient]);

  // Global hotkeys: ⌘O switcher, ⌘N new note, ⌘G graph
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // Auto-repeat (key held down) must not fire these — one ⌘W = one closed tab.
      if (!mod || e.repeat) return;
      if (e.key === "o") {
        e.preventDefault();
        setSwitcherOpen(!switcherOpen);
      } else if (e.key === "n" && !e.shiftKey) {
        e.preventDefault();
        newNote.mutate();
      } else if (e.key === "g") {
        e.preventDefault();
        openGraph();
      } else if (e.key === "p") {
        e.preventDefault();
        useWorkspaceStore.getState().setPaletteOpen(true);
      } else if (e.key === "w") {
        e.preventDefault();
        closeActiveTab();
      } else if (e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (e.key === "e") {
        e.preventDefault();
        const { editorMode, setEditorMode } = useWorkspaceStore.getState();
        setEditorMode(editorMode === "reading" ? "live" : "reading");
      } else if (e.key === "\\") {
        e.preventDefault();
        useWorkspaceStore.getState().splitRight();
      } else if (e.key === "[") {
        e.preventDefault();
        useWorkspaceStore.getState().navigateBack();
      } else if (e.key === "]") {
        e.preventDefault();
        useWorkspaceStore.getState().navigateForward();
      } else if (e.key >= "1" && e.key <= "9" && !e.shiftKey) {
        // ⌘1–8 jump to that tab, ⌘9 to the last (Obsidian's tab-index chords).
        e.preventDefault();
        useWorkspaceStore.getState().goToTabIndex(e.key === "9" ? -1 : Number(e.key) - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSwitcherOpen, switcherOpen, newNote, openGraph, closeActiveTab, setSettingsOpen]);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-ob-sidebar text-ob-text md:flex-row">
      {/* Reads the OAuth callback's outcome out of the URL. Renders nothing. */}
      <Suspense fallback={null}>
        <ConnectionCallbackNotice />
      </Suspense>
      {isMobile && (
        <MobileTopBar
          title={activeTab?.title ?? vault.name}
          onOpenLeft={() => setMobileDrawer("left")}
          onOpenRight={() => setMobileDrawer("right")}
        />
      )}

      {!isMobile && ribbonVisible && (
        <Ribbon
          onNewNote={() => newNote.mutate()}
          onOpenGraph={openGraph}
          onOpenDailyNote={openDailyNote}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}
      {!isMobile && (
        <SidebarLeft
          vaultId={vault.id}
          vaultName={vault.name}
          activeNoteId={activeNoteId}
          onOpenNote={openNote}
        />
      )}

      <main
        ref={mainRef}
        data-tour="editor"
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 border-ob-border md:border-l",
          isColumnSplit ? "flex-col" : "flex-row",
        )}
        onPointerDown={isMobile ? onEdgePointerDown : undefined}
        onPointerMove={isMobile ? onEdgePointerMove : undefined}
      >
        {panes.map((pane, paneIndex) => {
          // A phone shows one pane at a time — two side by side are 190px
          // each. The other pane is kept, just not drawn.
          if (isMobile && paneIndex !== activePane) return null;
          const paneTab = pane.tabs.find((t) => t.id === pane.activeTabId) ?? null;
          return (
            <section
              key={paneIndex}
              aria-label={`Editor pane ${String(paneIndex + 1)}`}
              onFocusCapture={() => setActivePane(paneIndex)}
              onClickCapture={() => setActivePane(paneIndex)}
              style={
                panes.length === 2 && !isMobile
                  ? { flexGrow: paneIndex === 0 ? splitRatio : 1 - splitRatio, flexBasis: 0 }
                  : undefined
              }
              className={cn(
                "flex min-h-0 min-w-0 flex-1 flex-col",
                paneIndex > 0 && (isColumnSplit ? "border-t border-ob-border" : "border-l border-ob-border"),
              )}
            >
              {prefs.showTabTitleBar && !isMobile && (
                <TabBar paneIndex={paneIndex} onNewNote={() => newNote.mutate()} />
              )}
              <div className="relative min-h-0 flex-1 bg-ob-bg">
                {paneTab === null && (
                  <EmptyState
                    onNewNote={() => newNote.mutate()}
                    onOpenFiles={isMobile ? () => setMobileDrawer("left") : undefined}
                  />
                )}
                {paneTab?.kind === "note" && (
                  <EditorPane vaultId={vault.id} noteId={paneTab.id} paneIndex={paneIndex} />
                )}
                {paneTab?.kind === "graph" && (
                  <GraphView
                    vaultId={vault.id}
                    focusNoteId={graphFocusNoteId}
                    // Clicking a node opens the note BESIDE the graph (graph
                    // stays put) and marks that node selected.
                    onOpenNote={(id, title) =>
                      isMobile
                        ? openNote(id, title)
                        : openNoteBeside({ id, kind: "note", title }, paneIndex)
                    }
                    onCreateNote={createFromGraph}
                  />
                )}
                {paneTab?.kind === "canvas" && (
                  <CanvasView vaultId={vault.id} canvasId={paneTab.id} />
                )}
                {paneIndex === panes.length - 1 && !isMobile && (
                  <StatusBar vaultId={vault.id} noteId={activeNoteId} />
                )}
                <PaneDropOverlay paneIndex={paneIndex} />
              </div>
            </section>
          );
        })}
        {panes.length === 2 && !isMobile && (
          <div
            role="separator"
            aria-orientation={isColumnSplit ? "horizontal" : "vertical"}
            aria-label="Resize split"
            aria-valuenow={Math.round(splitRatio * 100)}
            onPointerDown={onSplitDragStart}
            onDoubleClick={() => setSplitRatio(0.5)}
            style={isColumnSplit ? { top: `${splitRatio * 100}%` } : { left: `${splitRatio * 100}%` }}
            className={cn(
              "absolute z-20 hover:bg-ob-accent/40",
              isColumnSplit
                ? "left-0 h-1 w-full -translate-y-1/2 cursor-row-resize"
                : "top-0 h-full w-1 -translate-x-1/2 cursor-col-resize",
            )}
          />
        )}
      </main>

      {!isMobile && (
        <SidebarRight vaultId={vault.id} noteId={activeNoteId} onOpenNote={openNote} />
      )}

      {isMobile && !keyboard.open && (
        <MobileNavBar
          onNewNote={() => newNote.mutate()}
          onOpenTabs={() => setMobileTabsOpen(true)}
          onOpenMenu={() => setMobileMenuOpen(true)}
        />
      )}
      {isMobile && (
        <>
          <Sheet
            side="left"
            title="Navigation drawer"
            open={mobileDrawer === "left"}
            onOpenChange={(o) => setMobileDrawer(o ? "left" : null)}
          >
            <SidebarLeft
              drawer
              vaultId={vault.id}
              vaultName={vault.name}
              activeNoteId={activeNoteId}
              onOpenNote={openNote}
            />
          </Sheet>
          <Sheet
            side="right"
            title="Panels drawer"
            open={mobileDrawer === "right"}
            onOpenChange={(o) => setMobileDrawer(o ? "right" : null)}
          >
            <SidebarRight drawer vaultId={vault.id} noteId={activeNoteId} onOpenNote={openNote} />
          </Sheet>
          <MobileTabSwitcher
            open={mobileTabsOpen}
            onOpenChange={setMobileTabsOpen}
            onNewNote={() => newNote.mutate()}
          />
          <MobileMenu
            open={mobileMenuOpen}
            onOpenChange={setMobileMenuOpen}
            onOpenGraph={openGraph}
            onOpenDailyNote={openDailyNote}
            onOpenImport={() => setImportOpen(true)}
          />
        </>
      )}

      <QuickSwitcher vaultId={vault.id} onOpenNote={openNote} />
      <CommandPalette
        vaultId={vault.id}
        onNewNote={() => newNote.mutate()}
        onOpenGraph={openGraph}
        onDeleteActiveNote={deleteActiveNote}
        onCloseActiveTab={closeActiveTab}
        onOpenDailyNote={openDailyNote}
        onInsertTemplate={() => setTemplatePickerOpen(true)}
        onExportVault={exportVault}
        onOpenImport={() => setImportOpen(true)}
        onImportVault={() => importInputRef.current?.click()}
        onImportFolder={() => importFolderRef.current?.click()}
        pluginCommands={pluginCommands}
        onRunPluginCommand={runPluginCommand}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <SettingsModal vaultId={vault.id} open={settingsOpen} onOpenChange={setSettingsOpen} />
      <ImportDialog vaultId={vault.id} open={importOpen} onOpenChange={setImportOpen} />
      <SyncProgressCard vaultId={vault.id} />
      <DemoWorkspaceOffer />
      <OnboardingTour />
      <ConfirmDialog />
      <input
        ref={importInputRef}
        type="file"
        accept=".zip"
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) importVault(file);
          e.target.value = "";
        }}
      />
      <input
        ref={importFolderRef}
        type="file"
        multiple
        // @ts-expect-error — non-standard but supported by every target browser
        webkitdirectory=""
        directory=""
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          if (e.target.files?.length) importFolder(e.target.files);
          e.target.value = "";
        }}
      />
      <TemplatePicker
        vaultId={vault.id}
        noteId={activeNoteId}
        open={templatePickerOpen}
        onOpenChange={setTemplatePickerOpen}
      />
      <Toaster />
    </div>
  );
}

function EmptyState({ onNewNote, onOpenFiles }: { onNewNote: () => void; onOpenFiles?: () => void }) {
  // onOpenFiles is only passed on a phone — no keyboard, so no chords either.
  const touch = onOpenFiles !== undefined;
  const action = touch
    ? "min-h-11 rounded-lg px-4 text-[15px] text-ob-accent active:bg-ob-hover"
    : "text-[13px] text-ob-accent hover:text-ob-accent-hover hover:underline";
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2">
      <p className="text-[15px] text-ob-faint">No file is open</p>
      <button type="button" onClick={onNewNote} className={action}>
        {touch ? "Create new note" : "Create new note (⌘N)"}
      </button>
      <button
        type="button"
        onClick={() => useWorkspaceStore.getState().setSwitcherOpen(true)}
        className={action}
      >
        {touch ? "Find a note" : "Open quick switcher (⌘O)"}
      </button>
      {onOpenFiles && (
        <button type="button" onClick={onOpenFiles} className={action}>
          Browse files
        </button>
      )}
    </div>
  );
}
