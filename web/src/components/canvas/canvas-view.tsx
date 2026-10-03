"use client";

/**
 * Canvas — JSON Canvas board (Obsidian-compatible data format).
 *
 * Interaction model (kept deliberately simple):
 * - drag empty space to pan, wheel to zoom
 * - toolbar adds text / note cards at the viewport center
 * - drag a card to move it; bottom-right handle resizes
 * - click selects; Shift+click a second card draws an edge from the
 *   selected card; Delete removes the selected card (and its edges)
 * - double-click a text card to edit in place
 * - touch: pinch zooms / two-finger pans; a selected card shows an action
 *   bar (connect / edit / delete), tapping a selected text card edits it
 * - export / import .canvas JSON round-trips with Obsidian
 */

import { useQuery } from "@tanstack/react-query";
import { FileDown, FileUp, Link2, Pencil, StickyNote, FileText, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ReadingView } from "@/components/editor/reading-view";
import { canvasApi, noteApi, searchApi } from "@/lib/api/endpoints";
import type { CanvasData, CanvasEdge, CanvasNode } from "@/lib/api/types";
import { useVaultSettings, type CanvasBackground } from "@/lib/hooks/use-vault-settings";
import { toastError, useToastStore } from "@/lib/stores/toast-store";

/** Board background pattern that pans/zooms with the canvas. */
function canvasBackgroundStyle(kind: CanvasBackground, offsetX: number, offsetY: number, scale: number): React.CSSProperties {
  if (kind === "blank") return {};
  const size = 24 * scale;
  const line = "var(--ob-background-modifier-border)";
  const backgroundPosition = `${offsetX}px ${offsetY}px`;
  const backgroundSize = `${size}px ${size}px`;
  if (kind === "grid") {
    return {
      backgroundImage: `linear-gradient(to right, ${line} 1px, transparent 1px), linear-gradient(to bottom, ${line} 1px, transparent 1px)`,
      backgroundSize,
      backgroundPosition,
    };
  }
  // dots (Obsidian default)
  return {
    backgroundImage: `radial-gradient(circle, ${line} 1.2px, transparent 1.2px)`,
    backgroundSize,
    backgroundPosition,
  };
}

let idSeq = 0;
function newId(): string {
  idSeq += 1;
  return `n${Date.now().toString(36)}${idSeq}`;
}

const SIDES = {
  top: (n: CanvasNode) => ({ x: n.x + n.width / 2, y: n.y }),
  bottom: (n: CanvasNode) => ({ x: n.x + n.width / 2, y: n.y + n.height }),
  left: (n: CanvasNode) => ({ x: n.x, y: n.y + n.height / 2 }),
  right: (n: CanvasNode) => ({ x: n.x + n.width, y: n.y + n.height / 2 }),
} as const;

function edgePath(from: CanvasNode, to: CanvasNode, edge: CanvasEdge): string {
  const a = SIDES[edge.fromSide ?? "right"](from);
  const b = SIDES[edge.toSide ?? "left"](to);
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

/** Pick facing sides automatically from relative card positions. */
function autoSides(from: CanvasNode, to: CanvasNode): Pick<CanvasEdge, "fromSide" | "toSide"> {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { fromSide: "right", toSide: "left" } : { fromSide: "left", toSide: "right" };
  }
  return dy >= 0 ? { fromSide: "bottom", toSide: "top" } : { fromSide: "top", toSide: "bottom" };
}

export function CanvasView({ vaultId, canvasId }: { vaultId: string; canvasId: string }) {
  const toast = useToastStore((s) => s.push);
  const { canvasBackground } = useVaultSettings(vaultId);
  const { data: canvas } = useQuery({
    queryKey: ["canvas", vaultId, canvasId],
    queryFn: () => canvasApi.get(vaultId, canvasId),
    staleTime: Infinity,
    gcTime: 0,
  });

  const [data, setData] = useState<CanvasData | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  if (canvas && loadedFor !== canvas.id) {
    setLoadedFor(canvas.id);
    setData(canvas.data);
  }

  const [offset, setOffset] = useState({ x: 60, y: 60 });
  const [scale, setScale] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [notePicker, setNotePicker] = useState(false);
  const [noteQuery, setNoteQuery] = useState("");
  // touch "Connect" mode: the next tapped card becomes the edge target
  const [connecting, setConnecting] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef<{
    kind: "pan" | "move" | "resize";
    nodeId?: string;
    startX: number;
    startY: number;
    origin: { x: number; y: number; w?: number; h?: number };
    /** touch tap on an already-selected text card → edit on release if not moved */
    tapEdit?: boolean;
    moved?: boolean;
  } | null>(null);
  // Active pointers (for pinch) + the pinch gesture's starting state
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ d0: number; mx: number; my: number; ox: number; oy: number; s0: number } | null>(null);

  const persist = useCallback(
    (next: CanvasData) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        canvasApi.updateData(vaultId, canvasId, next).catch((e: unknown) => {
          toastError(e, "Could not save the canvas.");
        });
      }, 800);
    },
    [vaultId, canvasId],
  );

  const mutate = useCallback(
    (fn: (d: CanvasData) => CanvasData) => {
      setData((prev) => {
        if (!prev) return prev;
        const next = fn(prev);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const removeNode = useCallback(
    (id: string) => {
      mutate((d) => ({
        nodes: d.nodes.filter((n) => n.id !== id),
        edges: d.edges.filter((ed) => ed.fromNode !== id && ed.toNode !== id),
      }));
      setSelected(null);
      setConnecting(false);
    },
    [mutate],
  );

  const connect = (fromId: string, toId: string) => {
    mutate((d) => {
      const from = d.nodes.find((n) => n.id === fromId);
      const to = d.nodes.find((n) => n.id === toId);
      if (!from || !to) return d;
      return {
        ...d,
        edges: [...d.edges, { id: newId(), fromNode: from.id, toNode: to.id, ...autoSides(from, to) }],
      };
    });
  };

  // Delete key removes the selected card + its edges
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "Delete" || e.key === "Backspace") && selected && !editing) {
        const target = e.target as HTMLElement;
        if (target.closest("input, textarea, [contenteditable]")) return;
        e.preventDefault();
        removeNode(selected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, editing, removeNode]);

  const viewportCenterWorld = () => {
    const rect = stageRef.current?.getBoundingClientRect();
    const w = rect?.width ?? 800;
    const h = rect?.height ?? 600;
    return { x: (w / 2 - offset.x) / scale, y: (h / 2 - offset.y) / scale };
  };

  const addTextCard = () => {
    const c = viewportCenterWorld();
    const cascade = (data?.nodes.length ?? 0) * 36;
    const node: CanvasNode = {
      id: newId(),
      type: "text",
      x: Math.round(c.x - 125 + cascade),
      y: Math.round(c.y - 60 + cascade),
      width: 250,
      height: 140,
      text: "New card",
    };
    mutate((d) => ({ ...d, nodes: [...d.nodes, node] }));
    setSelected(node.id);
  };

  const addNoteCard = (path: string) => {
    const c = viewportCenterWorld();
    const cascade = (data?.nodes.length ?? 0) * 36;
    const node: CanvasNode = {
      id: newId(),
      type: "file",
      x: Math.round(c.x + 180 + cascade),
      y: Math.round(c.y - 100 + cascade),
      width: 300,
      height: 220,
      file: path,
    };
    mutate((d) => ({ ...d, nodes: [...d.nodes, node] }));
    setSelected(node.id);
    setNotePicker(false);
    setNoteQuery("");
  };

  const { data: pickerResults } = useQuery({
    queryKey: ["canvas-note-picker", vaultId, noteQuery],
    queryFn: () => searchApi.quickSwitch(vaultId, noteQuery, 8),
    enabled: notePicker,
  });

  /** Track every pointer (capture phase, before card/stage handlers); a second
   *  finger turns the gesture into pinch-zoom + two-finger pan. */
  const onRootPointerDownCapture = (e: React.PointerEvent) => {
    if (e.isPrimary) pointers.current.clear(); // first finger: drop any stale entries
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size !== 2) return;
    const [a, b] = [...pointers.current.values()];
    const rect = stageRef.current?.getBoundingClientRect();
    pinchRef.current = {
      d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      mx: (a.x + b.x) / 2 - (rect?.left ?? 0),
      my: (a.y + b.y) / 2 - (rect?.top ?? 0),
      ox: offset.x,
      oy: offset.y,
      s0: scale,
    };
    dragRef.current = null;
  };

  const onStagePointerDown = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget || pointers.current.size > 1) return;
    setSelected(null);
    setConnecting(false);
    // editing textarea commits itself via blur — do not unmount it here
    dragRef.current = { kind: "pan", startX: e.clientX, startY: e.clientY, origin: { ...offset } };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pinch = pinchRef.current;
    if (pinch && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const rect = stageRef.current?.getBoundingClientRect();
      const mx = (a.x + b.x) / 2 - (rect?.left ?? 0);
      const my = (a.y + b.y) / 2 - (rect?.top ?? 0);
      const next = Math.min(2, Math.max(0.25, (pinch.s0 * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.d0));
      // keep the world point under the starting midpoint under the current midpoint
      setScale(next);
      setOffset({ x: mx - ((pinch.mx - pinch.ox) / pinch.s0) * next, y: my - ((pinch.my - pinch.oy) / pinch.s0) * next });
      return;
    }
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 6) drag.moved = true;
    if (drag.kind === "pan") {
      setOffset({ x: drag.origin.x + dx, y: drag.origin.y + dy });
    } else if (drag.kind === "move" && drag.nodeId) {
      setData((d) =>
        d
          ? {
              ...d,
              nodes: d.nodes.map((n) =>
                n.id === drag.nodeId
                  ? { ...n, x: Math.round(drag.origin.x + dx / scale), y: Math.round(drag.origin.y + dy / scale) }
                  : n,
              ),
            }
          : d,
      );
    } else if (drag.kind === "resize" && drag.nodeId) {
      setData((d) =>
        d
          ? {
              ...d,
              nodes: d.nodes.map((n) =>
                n.id === drag.nodeId
                  ? {
                      ...n,
                      width: Math.max(120, Math.round((drag.origin.w ?? 0) + dx / scale)),
                      height: Math.max(60, Math.round((drag.origin.h ?? 0) + dy / scale)),
                    }
                  : n,
              ),
            }
          : d,
      );
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pinchRef.current) {
      if (pointers.current.size < 2) pinchRef.current = null;
      return;
    }
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.tapEdit && !drag.moved && drag.nodeId) setEditing(drag.nodeId);
    if (drag && drag.kind !== "pan" && data) persist(data);
  };

  const onCardPointerDown = (e: React.PointerEvent, node: CanvasNode) => {
    e.stopPropagation();
    if (editing === node.id || pointers.current.size > 1) return;
    if ((e.shiftKey || connecting) && selected && selected !== node.id) {
      // connect selected → clicked
      connect(selected, node.id);
      setConnecting(false);
      return;
    }
    setSelected(node.id);
    dragRef.current = {
      kind: "move",
      nodeId: node.id,
      startX: e.clientX,
      startY: e.clientY,
      origin: { x: node.x, y: node.y },
      tapEdit: e.pointerType !== "mouse" && node.type === "text" && selected === node.id,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onResizeDown = (e: React.PointerEvent, node: CanvasNode) => {
    e.stopPropagation();
    if (pointers.current.size > 1) return;
    dragRef.current = {
      kind: "resize",
      nodeId: node.id,
      startX: e.clientX,
      startY: e.clientY,
      origin: { x: node.x, y: node.y, w: node.width, h: node.height },
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onWheel = (e: React.WheelEvent) => {
    const next = Math.min(2, Math.max(0.25, scale * (e.deltaY > 0 ? 0.9 : 1.1)));
    setScale(next);
  };

  const exportCanvas = () => {
    if (!data || !canvas) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${canvas.name}.canvas`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importInput = useRef<HTMLInputElement>(null);
  const importCanvas = (file: File) => {
    void file.text().then((text) => {
      try {
        const parsed = JSON.parse(text) as CanvasData;
        if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) throw new Error("bad shape");
        mutate(() => ({ nodes: parsed.nodes, edges: parsed.edges }));
        toast("Canvas imported.", "info");
      } catch {
        toastError(new Error("Not a valid .canvas file."), "Not a valid .canvas file.");
      }
    });
  };

  if (!data) {
    return <div className="flex h-full items-center justify-center text-[13px] text-ob-faint">Loading canvas…</div>;
  }

  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const selectedNode = selected ? byId.get(selected) : undefined;
  const actionBtn =
    "flex size-10 items-center justify-center rounded-md text-ob-muted hover:bg-ob-hover hover:text-ob-text";

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-ob-bg"
      data-canvas-root
      data-canvas-bg={canvasBackground}
      onPointerDownCapture={onRootPointerDownCapture}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/* Board background pattern — pans/zooms with the stage */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={canvasBackgroundStyle(canvasBackground, offset.x, offset.y, scale)}
      />
      {/* Toolbar */}
      <div className="absolute top-3 left-3 z-20 flex items-center gap-1 rounded-lg border border-ob-border bg-ob-sidebar/95 p-1 backdrop-blur">
        <button
          type="button"
          onClick={addTextCard}
          className="flex h-8 items-center gap-1.5 rounded-md px-2 text-[12px] max-md:h-10 text-ob-muted hover:bg-ob-hover hover:text-ob-text"
        >
          <StickyNote className="size-4" strokeWidth={1.75} /> Text card
        </button>
        <button
          type="button"
          onClick={() => setNotePicker((v) => !v)}
          className="flex h-8 items-center gap-1.5 rounded-md px-2 text-[12px] max-md:h-10 text-ob-muted hover:bg-ob-hover hover:text-ob-text"
        >
          <FileText className="size-4" strokeWidth={1.75} /> Note card
        </button>
        <span className="mx-1 h-5 w-px bg-ob-border" />
        <button
          type="button"
          aria-label="Export canvas"
          onClick={exportCanvas}
          className="flex size-8 items-center justify-center rounded-md text-ob-muted max-md:size-10 hover:bg-ob-hover hover:text-ob-text"
        >
          <FileDown className="size-4" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          aria-label="Import canvas"
          onClick={() => importInput.current?.click()}
          className="flex size-8 items-center justify-center rounded-md text-ob-muted max-md:size-10 hover:bg-ob-hover hover:text-ob-text"
        >
          <FileUp className="size-4" strokeWidth={1.75} />
        </button>
        <input
          ref={importInput}
          type="file"
          accept=".canvas,application/json"
          className="hidden"
          aria-hidden
          tabIndex={-1}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importCanvas(f);
            e.target.value = "";
          }}
        />
      </div>
      <p className="absolute bottom-3 left-3 z-20 text-[11px] text-ob-faint max-md:hidden pointer-coarse:hidden">
        Drag to pan · wheel to zoom · Shift+click connects cards · Delete removes
      </p>
      <p className="absolute right-3 bottom-3 left-3 z-20 hidden text-[11px] text-ob-faint max-md:block pointer-coarse:block">
        {connecting ? "Tap another card to connect it" : "Drag to pan · pinch to zoom · tap a card for actions"}
      </p>

      {/* Touch action bar for the selected card (desktop uses Shift+click / Delete / double-click) */}
      {selectedNode && !editing && (
        <div
          role="toolbar"
          aria-label="Card actions"
          className="absolute bottom-9 left-1/2 z-20 hidden -translate-x-1/2 items-center gap-1 rounded-lg border border-ob-border bg-ob-sidebar/95 p-1 shadow-lg backdrop-blur max-md:flex pointer-coarse:flex"
        >
          <button
            type="button"
            aria-label="Connect card"
            aria-pressed={connecting}
            onClick={() => setConnecting((v) => !v)}
            className={`${actionBtn} ${connecting ? "bg-ob-hover text-ob-accent" : ""}`}
          >
            <Link2 className="size-5" strokeWidth={1.75} />
          </button>
          {selectedNode.type === "text" && (
            <button type="button" aria-label="Edit card" onClick={() => setEditing(selectedNode.id)} className={actionBtn}>
              <Pencil className="size-5" strokeWidth={1.75} />
            </button>
          )}
          <button
            type="button"
            aria-label="Delete card"
            onClick={() => removeNode(selectedNode.id)}
            className={actionBtn}
          >
            <Trash2 className="size-5" strokeWidth={1.75} />
          </button>
        </div>
      )}

      {/* Note picker */}
      {notePicker && (
        <div data-canvas-picker className="absolute top-14 left-3 z-30 w-72 rounded-lg border border-ob-border bg-ob-sidebar p-2 shadow-xl">
          <input
            autoFocus
            value={noteQuery}
            onChange={(e) => setNoteQuery(e.target.value)}
            placeholder="Find a note…"
            aria-label="Find a note for the canvas"
            className="mb-1 h-8 w-full rounded border border-ob-border bg-ob-bg px-2 text-[13px] text-ob-text outline-none max-md:h-10 max-md:text-[16px]"
          />
          {pickerResults?.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => addNoteCard(r.path)}
              className="block w-full truncate rounded px-2 py-1 text-left text-[13px] text-ob-muted hover:bg-ob-hover hover:text-ob-text"
            >
              {r.title}
            </button>
          ))}
        </div>
      )}

      {/* Stage */}
      <div
        ref={stageRef}
        className="h-full w-full cursor-grab touch-none active:cursor-grabbing"
        onPointerDown={onStagePointerDown}
        onWheel={onWheel}
      >
        <div
          className="pointer-events-none absolute top-0 left-0"
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`, transformOrigin: "0 0" }}
        >
          {/* Edges */}
          <svg className="absolute overflow-visible" width={1} height={1} aria-hidden>
            <defs>
              <marker id="canvas-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--ob-text-faint)" />
              </marker>
            </defs>
            {data.edges.map((edge) => {
              const from = byId.get(edge.fromNode);
              const to = byId.get(edge.toNode);
              if (!from || !to) return null;
              return (
                <path
                  key={edge.id}
                  d={edgePath(from, to, edge)}
                  fill="none"
                  stroke="var(--ob-text-faint)"
                  strokeWidth={2 / scale}
                  markerEnd="url(#canvas-arrow)"
                  data-canvas-edge
                />
              );
            })}
          </svg>

          {/* Cards */}
          {data.nodes.map((node) => (
            <div
              key={node.id}
              data-canvas-card={node.type}
              onPointerDown={(e) => onCardPointerDown(e, node)}
              onDoubleClick={() => node.type === "text" && setEditing(node.id)}
              className={`pointer-events-auto absolute flex flex-col overflow-hidden rounded-lg border bg-ob-sidebar shadow-md ${
                selected === node.id ? "border-ob-accent ring-1 ring-[var(--ob-interactive-accent)]" : "border-ob-border"
              }`}
              style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
            >
              {node.type === "text" &&
                (editing === node.id ? (
                  <textarea
                    autoFocus
                    defaultValue={node.text ?? ""}
                    aria-label="Card text"
                    onKeyDown={(e) => {
                      if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
                    }}
                    onBlur={(e) => {
                      const text = e.target.value;
                      mutate((d) => ({
                        ...d,
                        nodes: d.nodes.map((n) => (n.id === node.id ? { ...n, text } : n)),
                      }));
                      setEditing(null);
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="h-full w-full resize-none bg-transparent p-3 text-[13px] text-ob-text outline-none max-md:text-[16px]"
                  />
                ) : (
                  <div className="nodum-canvas-card-body h-full overflow-auto p-3 text-[13px]">
                    <ReadingView content={node.text ?? ""} vaultId={vaultId} onNavigate={() => undefined} depth={2} />
                  </div>
                ))}
              {node.type === "file" && node.file && (
                <NoteCard vaultId={vaultId} path={node.file} />
              )}
              {node.type === "link" && node.url && (
                <a
                  href={node.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="p-3 text-[13px] text-ob-accent underline"
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  {node.url}
                </a>
              )}
              <div
                role="presentation"
                aria-label="Resize card"
                onPointerDown={(e) => onResizeDown(e, node)}
                // coarse pointers get a 40px hit area; the visible triangle stays 16px
                className="absolute right-0 bottom-0 size-4 cursor-nwse-resize pointer-coarse:size-10"
                style={{
                  background:
                    "linear-gradient(135deg, transparent 55%, var(--ob-background-modifier-border) 55%) right bottom / 16px 16px no-repeat",
                }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function NoteCard({ vaultId, path }: { vaultId: string; path: string }) {
  const { data: note, isError } = useQuery({
    queryKey: ["canvas-note", vaultId, path],
    queryFn: () => noteApi.getByPath(vaultId, path),
    retry: false,
  });
  if (isError) return <p className="p-3 text-[12px] text-ob-faint">Note “{path}” not found.</p>;
  if (!note) return <p className="p-3 text-[12px] text-ob-faint">Loading…</p>;
  return (
    <>
      <p className="border-b border-ob-border px-3 py-1.5 text-[12px] font-semibold text-ob-text">{note.title}</p>
      <div className="nodum-canvas-card-body min-h-0 flex-1 overflow-auto p-3 text-[12px]">
        <ReadingView content={note.content} vaultId={vaultId} onNavigate={() => undefined} depth={2} />
      </div>
    </>
  );
}
