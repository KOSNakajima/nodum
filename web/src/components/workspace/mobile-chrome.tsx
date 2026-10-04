"use client";

/**
 * Phone chrome — what replaces the ribbon, the tab strip and the docked
 * sidebars below 768px. Modelled on Obsidian mobile: a slim top bar (left
 * drawer · note title · right drawer) and a bottom navigation bar (back ·
 * forward · new note · quick switcher · tabs · menu). The bottom bar steps
 * aside while the keyboard is up; the editor toolbar takes its place.
 */

import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CalendarDays,
  Command,
  FileText,
  GitFork,
  Import,
  LayoutDashboard,
  LogOut,
  Menu,
  PanelRight,
  Pin,
  Plus,
  Search,
  Settings,
  SquarePen,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";

import { Sheet } from "@/components/ui/sheet";
import { DOCS_URL } from "@/lib/app-meta";
import { useAuthStore } from "@/lib/stores/auth-store";
import { historyStep, useWorkspaceStore, type Tab } from "@/lib/stores/workspace-store";
import { cn } from "@/lib/utils";

const iconBtn =
  "flex size-11 shrink-0 items-center justify-center rounded-lg text-ob-muted active:bg-ob-hover active:text-ob-text disabled:text-ob-faint/40";

export function MobileTopBar({
  title,
  onOpenLeft,
  onOpenRight,
}: {
  title: string;
  onOpenLeft: () => void;
  onOpenRight: () => void;
}) {
  return (
    <header className="flex shrink-0 items-center gap-1 border-b border-ob-border bg-ob-sidebar px-1 pt-[env(safe-area-inset-top)] pr-[max(4px,env(safe-area-inset-right))] pl-[max(4px,env(safe-area-inset-left))]">
      <button type="button" aria-label="Open navigation" onClick={onOpenLeft} className={iconBtn}>
        <Menu className="size-5" strokeWidth={1.75} />
      </button>
      <span className="min-w-0 flex-1 truncate text-center text-[15px] font-medium">{title}</span>
      <button type="button" aria-label="Open panels" onClick={onOpenRight} className={iconBtn}>
        <PanelRight className="size-5" strokeWidth={1.75} />
      </button>
    </header>
  );
}

export function MobileNavBar({
  onNewNote,
  onOpenTabs,
  onOpenMenu,
}: {
  onNewNote: () => void;
  onOpenTabs: () => void;
  onOpenMenu: () => void;
}) {
  const paneIndex = useWorkspaceStore((s) => s.activePane);
  const pane = useWorkspaceStore((s) => s.panes[s.activePane]);
  const navigateBack = useWorkspaceStore((s) => s.navigateBack);
  const navigateForward = useWorkspaceStore((s) => s.navigateForward);
  const setSwitcherOpen = useWorkspaceStore((s) => s.setSwitcherOpen);
  const canBack = pane ? historyStep(pane, -1) !== null : false;
  const canForward = pane ? historyStep(pane, 1) !== null : false;
  const tabCount = pane?.tabs.length ?? 0;

  return (
    <nav
      aria-label="Workspace"
      className="flex shrink-0 items-center justify-around border-t border-ob-border bg-ob-sidebar px-2 pt-1 pb-[max(4px,env(safe-area-inset-bottom))]"
    >
      <button type="button" aria-label="Navigate back" disabled={!canBack} onClick={() => navigateBack(paneIndex)} className={iconBtn}>
        <ArrowLeft className="size-5" strokeWidth={1.75} />
      </button>
      <button
        type="button"
        aria-label="Navigate forward"
        disabled={!canForward}
        onClick={() => navigateForward(paneIndex)}
        className={iconBtn}
      >
        <ArrowRight className="size-5" strokeWidth={1.75} />
      </button>
      <button type="button" aria-label="New note" onClick={onNewNote} className={iconBtn}>
        <SquarePen className="size-5" strokeWidth={1.75} />
      </button>
      <button type="button" aria-label="Quick switcher" onClick={() => setSwitcherOpen(true)} className={iconBtn}>
        <Search className="size-5" strokeWidth={1.75} />
      </button>
      <button
        type="button"
        aria-label={`Open tabs (${String(tabCount)})`}
        onClick={onOpenTabs}
        className={iconBtn}
      >
        {/* Obsidian's tab-count square */}
        <span className="flex size-[22px] items-center justify-center rounded-[5px] border-[1.75px] border-current text-[11px] font-semibold tabular-nums">
          {tabCount > 99 ? "∞" : tabCount}
        </span>
      </button>
      <button type="button" aria-label="Menu" onClick={onOpenMenu} className={iconBtn}>
        <Menu className="size-5" strokeWidth={1.75} />
      </button>
    </nav>
  );
}

function tabIcon(tab: Tab) {
  if (tab.kind === "graph") return <GitFork className="size-4 rotate-90" strokeWidth={1.75} />;
  if (tab.kind === "canvas") return <LayoutDashboard className="size-4" strokeWidth={1.75} />;
  return <FileText className="size-4" strokeWidth={1.75} />;
}

/** Full list of the active pane's tabs — the phone's tab strip. */
export function MobileTabSwitcher({
  open,
  onOpenChange,
  onNewNote,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNewNote: () => void;
}) {
  const paneIndex = useWorkspaceStore((s) => s.activePane);
  const pane = useWorkspaceStore((s) => s.panes[s.activePane]);
  const setActiveTab = useWorkspaceStore((s) => s.setActiveTab);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const closeOtherTabs = useWorkspaceStore((s) => s.closeOtherTabs);
  const tabs = pane?.tabs ?? [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange} side="bottom" title="Open tabs">
      <div className="flex items-center justify-between px-4 pb-2">
        <h2 className="text-[15px] font-semibold">
          {tabs.length} {tabs.length === 1 ? "tab" : "tabs"}
        </h2>
        <div className="flex items-center gap-1">
          {tabs.length > 1 && (
            <button
              type="button"
              onClick={closeOtherTabs}
              className="h-9 rounded-lg px-3 text-[14px] text-ob-muted active:bg-ob-hover"
            >
              Close others
            </button>
          )}
          <button
            type="button"
            aria-label="New note"
            onClick={() => {
              onOpenChange(false);
              onNewNote();
            }}
            className={iconBtn}
          >
            <Plus className="size-5" strokeWidth={1.75} />
          </button>
        </div>
      </div>
      <ul data-sheet-scroll className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
        {tabs.length === 0 && <li className="px-3 py-6 text-center text-[14px] text-ob-faint">No open tabs</li>}
        {tabs.map((tab) => {
          const active = tab.id === pane?.activeTabId;
          return (
            <li key={tab.id} className="flex items-center">
              <button
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => {
                  setActiveTab(tab.id, paneIndex);
                  onOpenChange(false);
                }}
                className={cn(
                  "flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-lg px-3 text-left text-[15px] active:bg-ob-hover",
                  active ? "bg-ob-active text-ob-text" : "text-ob-muted",
                )}
              >
                <span className="shrink-0 text-ob-faint">{tabIcon(tab)}</span>
                <span className="min-w-0 flex-1 truncate">{tab.title}</span>
                {tab.pinned && <Pin aria-label="Pinned" className="size-3.5 shrink-0 text-ob-faint" strokeWidth={1.75} />}
              </button>
              {!tab.pinned && (
                <button
                  type="button"
                  aria-label={`Close ${tab.title}`}
                  onClick={() => closeTab(tab.id, paneIndex)}
                  className={iconBtn}
                >
                  <X className="size-4" strokeWidth={1.75} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}

/** The ribbon's actions, as a phone menu. */
export function MobileMenu({
  open,
  onOpenChange,
  onOpenGraph,
  onOpenDailyNote,
  onOpenImport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenGraph: () => void;
  onOpenDailyNote: () => void;
  onOpenImport: () => void;
}) {
  const router = useRouter();
  const logout = useAuthStore((s) => s.logout);
  const setPaletteOpen = useWorkspaceStore((s) => s.setPaletteOpen);
  const setLeftPane = useWorkspaceStore((s) => s.setLeftPane);
  const setSettingsOpen = useWorkspaceStore((s) => s.setSettingsOpen);

  // Close the sheet first so focus returns before the next surface opens.
  const run = (fn: () => void) => () => {
    onOpenChange(false);
    requestAnimationFrame(fn);
  };

  const item = "flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-[15px] text-ob-text active:bg-ob-hover";
  const icon = "size-5 shrink-0 text-ob-muted";

  return (
    <Sheet open={open} onOpenChange={onOpenChange} side="bottom" title="Menu">
      <div data-sheet-scroll className="min-h-0 overflow-y-auto overscroll-contain px-2 pb-2">
        <button type="button" className={item} onClick={run(onOpenGraph)}>
          <GitFork className={cn(icon, "rotate-90")} strokeWidth={1.75} /> Graph view
        </button>
        <button type="button" className={item} onClick={run(onOpenDailyNote)}>
          <CalendarDays className={icon} strokeWidth={1.75} /> Today’s daily note
        </button>
        <button type="button" className={item} onClick={run(() => setLeftPane("search"))}>
          <Search className={icon} strokeWidth={1.75} /> Search in vault
        </button>
        <button type="button" className={item} onClick={run(() => setPaletteOpen(true))}>
          <Command className={icon} strokeWidth={1.75} /> Command palette
        </button>
        <button type="button" className={item} onClick={run(onOpenImport)}>
          <Import className={icon} strokeWidth={1.75} /> Import data
        </button>
        <div role="separator" className="mx-3 my-1 h-px bg-ob-border" />
        <button type="button" className={item} onClick={run(() => setSettingsOpen(true))}>
          <Settings className={icon} strokeWidth={1.75} /> Settings
        </button>
        <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className={item}>
          <BookOpen className={icon} strokeWidth={1.75} /> Documentation
        </a>
        <button
          type="button"
          className={item}
          onClick={run(() => {
            void (async () => {
              await logout();
              router.replace("/");
            })();
          })}
        >
          <LogOut className={icon} strokeWidth={1.75} /> Log out
        </button>
      </div>
    </Sheet>
  );
}
