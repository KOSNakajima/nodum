"use client";

/**
 * Sheet — a Radix dialog pinned to a screen edge: the mobile drawers and
 * bottom sheets. Radix brings the focus trap, Escape, focus return and the
 * inert background; this adds the slide animation and swipe-to-dismiss
 * (drag toward the edge it came from; past a third of its size, or a flick,
 * closes it).
 */

import { Dialog as DialogPrimitive } from "radix-ui";
import { useRef } from "react";

import { cn } from "@/lib/utils";

type Side = "left" | "right" | "bottom";

const SIDE_CLASS: Record<Side, string> = {
  left: "inset-y-0 left-0 h-full w-[85vw] max-w-[340px] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]",
  right:
    "inset-y-0 right-0 h-full w-[85vw] max-w-[340px] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pr-[env(safe-area-inset-right)]",
  bottom:
    "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-2xl pb-[max(8px,env(safe-area-inset-bottom))]",
};

export function Sheet({
  open,
  onOpenChange,
  side,
  title,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side: Side;
  /** Accessible name; visually hidden. */
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  const drag = useRef<{ id: number; x: number; y: number; t: number; d: number; live: boolean } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Signed distance moved TOWARD the edge the sheet lives on.
  const toward = (e: React.PointerEvent, s: NonNullable<typeof drag.current>) =>
    side === "left" ? s.x - e.clientX : side === "right" ? e.clientX - s.x : e.clientY - s.y;

  const setOffset = (px: number) => {
    const el = contentRef.current;
    if (!el) return;
    el.style.transform =
      px <= 0 ? "" : side === "bottom" ? `translateY(${String(px)}px)` : `translateX(${String(side === "left" ? -px : px)}px)`;
    el.style.transition = px <= 0 ? "transform 160ms ease-out" : "none";
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          // Close on the backdrop directly: in production builds Radix's
          // outside-press detection swallowed the first tap after a drawer
          // opened (the second one closed it) — reproduced in
          // e2e/mobile-workspace.spec.ts, cause inside Radix not pinned down.
          onPointerDown={() => onOpenChange(false)}
          className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <DialogPrimitive.Content
          ref={contentRef}
          data-side={side}
          aria-describedby={undefined}
          // Focus the sheet itself, not its first button: that button's
          // tooltip would pop open on focus (and then eat the first Escape).
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            contentRef.current?.focus();
          }}
          className={cn(
            "nodum-sheet fixed z-50 flex flex-col overflow-hidden bg-ob-sidebar text-ob-text shadow-2xl outline-none overscroll-contain",
            SIDE_CLASS[side],
            className,
          )}
          onPointerDown={(e) => {
            if (e.pointerType === "mouse") return;
            drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, d: 0, live: false };
          }}
          onPointerMove={(e) => {
            const s = drag.current;
            if (!s || s.id !== e.pointerId) return;
            const d = toward(e, s);
            if (!s.live) {
              // Only a drag that is mostly along the dismiss axis takes over;
              // anything else is the list scrolling.
              const along = side === "bottom" ? Math.abs(e.clientY - s.y) : Math.abs(e.clientX - s.x);
              const across = side === "bottom" ? Math.abs(e.clientX - s.x) : Math.abs(e.clientY - s.y);
              if (across > 10 && across > along) {
                drag.current = null;
                return;
              }
              // A bottom sheet whose list is scrolled must scroll back first.
              const scroller = (e.target as HTMLElement).closest("[data-sheet-scroll]");
              if (side === "bottom" && scroller && scroller.scrollTop > 0) {
                drag.current = null;
                return;
              }
              if (d < 12) return;
              s.live = true;
            }
            s.d = d;
            setOffset(d);
          }}
          onPointerUp={(e) => {
            const s = drag.current;
            drag.current = null;
            if (!s?.live) return;
            const size = side === "bottom" ? (contentRef.current?.offsetHeight ?? 1) : (contentRef.current?.offsetWidth ?? 1);
            const velocity = s.d / Math.max(1, e.timeStamp - s.t);
            // Closing leaves the offset in place: the exit animation runs from
            // wherever the finger let go, not from a snap back.
            if (s.d > size / 3 || velocity > 0.6) onOpenChange(false);
            else setOffset(0);
          }}
          onPointerCancel={() => {
            drag.current = null;
            setOffset(0);
          }}
        >
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          {side === "bottom" && (
            <div aria-hidden className="flex shrink-0 justify-center pt-2 pb-1">
              <span className="h-1 w-9 rounded-full bg-ob-border" />
            </div>
          )}
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
