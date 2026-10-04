"use client";

/**
 * The row of formatting actions that rides on top of the on-screen keyboard
 * (Obsidian mobile's "mobile toolbar"). Shown only while the editor has focus
 * on a touch device; scrolls sideways when it does not fit.
 *
 * Every button cancels its own pointerdown: if the tap moved focus, the editor
 * would blur, iOS would drop the keyboard, and the selection the command is
 * meant to act on would be gone.
 */

import { startCompletion } from "@codemirror/autocomplete";
import { indentLess, indentMore, redo, undo } from "@codemirror/commands";
import type { StateCommand } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  Bold,
  Brackets,
  CheckSquare,
  ChevronDown,
  Code,
  Hash,
  Heading,
  Highlighter,
  IndentDecrease,
  IndentIncrease,
  Italic,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Strikethrough,
  Undo2,
} from "lucide-react";
import { useEffect, useRef } from "react";

import {
  activeFormats,
  insertTag,
  insertWikilink,
  setHeading,
  toggleBold,
  toggleBlockquote,
  toggleBulletList,
  toggleHighlightCmd,
  toggleInlineCode,
  toggleItalic,
  toggleNumberedList,
  toggleStrikethrough,
  toggleTaskList,
} from "@/lib/editor/format-commands";
import { useVirtualKeyboard } from "@/lib/hooks/use-virtual-keyboard";

type Action = {
  label: string;
  icon: React.ReactNode;
  run: (view: EditorView) => void;
};

const ic = "size-[18px]";
const sw = 1.75;

const cmd = (c: StateCommand) => (view: EditorView) => {
  c(view);
};

const ACTIONS: Action[] = [
  { label: "Undo", icon: <Undo2 className={ic} strokeWidth={sw} />, run: (v) => void undo(v) },
  { label: "Redo", icon: <Redo2 className={ic} strokeWidth={sw} />, run: (v) => void redo(v) },
  {
    label: "Insert link",
    icon: <Brackets className={ic} strokeWidth={sw} />,
    run: (v) => {
      insertWikilink(v);
      startCompletion(v);
    },
  },
  {
    label: "Insert tag",
    icon: <Hash className={ic} strokeWidth={sw} />,
    run: (v) => {
      insertTag(v);
      startCompletion(v);
    },
  },
  {
    // Cycles plain → H1 … H6 → plain, like tapping Obsidian's heading key.
    label: "Heading",
    icon: <Heading className={ic} strokeWidth={sw} />,
    run: (v) => {
      const level = activeFormats(v.state).heading;
      setHeading((level >= 6 ? 0 : level + 1) as 0 | 1 | 2 | 3 | 4 | 5 | 6)(v);
    },
  },
  { label: "Bold", icon: <Bold className={ic} strokeWidth={sw} />, run: cmd(toggleBold) },
  { label: "Italic", icon: <Italic className={ic} strokeWidth={sw} />, run: cmd(toggleItalic) },
  { label: "Highlight", icon: <Highlighter className={ic} strokeWidth={sw} />, run: cmd(toggleHighlightCmd) },
  { label: "Strikethrough", icon: <Strikethrough className={ic} strokeWidth={sw} />, run: cmd(toggleStrikethrough) },
  { label: "Inline code", icon: <Code className={ic} strokeWidth={sw} />, run: cmd(toggleInlineCode) },
  { label: "Task list", icon: <CheckSquare className={ic} strokeWidth={sw} />, run: cmd(toggleTaskList) },
  { label: "Bullet list", icon: <List className={ic} strokeWidth={sw} />, run: cmd(toggleBulletList) },
  { label: "Numbered list", icon: <ListOrdered className={ic} strokeWidth={sw} />, run: cmd(toggleNumberedList) },
  { label: "Quote", icon: <Quote className={ic} strokeWidth={sw} />, run: cmd(toggleBlockquote) },
  { label: "Indent", icon: <IndentIncrease className={ic} strokeWidth={sw} />, run: (v) => void indentMore(v) },
  { label: "Outdent", icon: <IndentDecrease className={ic} strokeWidth={sw} />, run: (v) => void indentLess(v) },
];

export function MobileEditToolbar({ getView }: { getView: () => EditorView | null }) {
  const keyboard = useVirtualKeyboard();
  const barRef = useRef<HTMLDivElement>(null);

  // Is it THIS pane's editor that has focus? (focus, not the keyboard,
  // decides — the title field and other inputs raise the keyboard too.)
  const view = keyboard.open ? getView() : null;
  const editing = view !== null && view.hasFocus;

  // Keep the caret clear of the bar once the keyboard has settled.
  useEffect(() => {
    if (!editing || !view) return;
    const id = requestAnimationFrame(() => {
      const head = view.state.selection.main.head;
      const caret = view.coordsAtPos(head);
      const bar = barRef.current?.getBoundingClientRect();
      if (caret && bar && caret.bottom > bar.top - 8) {
        view.scrollDOM.closest("[data-editor-scroll]")?.scrollBy({ top: caret.bottom - bar.top + 48 });
      }
    });
    return () => cancelAnimationFrame(id);
  }, [editing, view, keyboard.inset]);

  if (!editing || !view) return null;

  return (
    <div
      ref={barRef}
      role="toolbar"
      aria-label="Formatting"
      style={{ bottom: keyboard.inset }}
      className="fixed inset-x-0 z-40 flex items-center border-t border-ob-border bg-ob-sidebar pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]"
      // Nothing in here may take focus from the editor (see header comment).
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="flex min-w-0 flex-1 items-center overflow-x-auto overscroll-x-contain [scrollbar-width:none]">
        {ACTIONS.map((a) => (
          <button
            key={a.label}
            type="button"
            tabIndex={-1}
            aria-label={a.label}
            onClick={() => {
              a.run(view);
              view.focus();
            }}
            className="flex h-11 w-11 shrink-0 items-center justify-center text-ob-muted active:bg-ob-hover active:text-ob-text"
          >
            {a.icon}
          </button>
        ))}
      </div>
      <button
        type="button"
        tabIndex={-1}
        aria-label="Hide keyboard"
        onClick={() => view.contentDOM.blur()}
        className="flex h-11 w-11 shrink-0 items-center justify-center border-l border-ob-border text-ob-muted active:bg-ob-hover"
      >
        <ChevronDown className={ic} strokeWidth={sw} />
      </button>
    </div>
  );
}
