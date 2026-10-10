"use client";

/**
 * The steps behind an assistant reply — one line per tool call, the way a
 * terminal agent prints them:
 *
 *   ● Searched "spaced repetition"
 *     └ 3 results
 *
 * Stored with the reply (the server records every call, failures included), so
 * a restored thread shows the same trail. Notes open in the workspace and
 * visited pages open in a new tab.
 */

import { Loader2 } from "lucide-react";

import type { AIAction } from "@/lib/api/types";
import { cn } from "@/lib/utils";

const FAILED_VERB: Record<string, string> = {
  search_notes: "Search",
  read_note: "Read",
  create_note: "Create",
  append_to_note: "Update",
  fetch_url: "Visit",
};

interface Line {
  verb: string;
  target: string;
  summary?: string;
  failed?: boolean;
  open?: () => void;
  href?: string;
}

function plural(n: number, word: string) {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

/** host + path, the part of a URL that says where it went. */
function shortUrl(url: string) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}

function describe(action: AIAction, onOpenNote: (id: string, title: string) => void): Line {
  switch (action.kind) {
    case "searched":
      return {
        verb: "Searched",
        target: `"${action.query}"`,
        summary: action.count ? plural(action.count, "result") : "No results",
      };
    case "read":
      return { verb: "Read", target: action.title, open: () => onOpenNote(action.note_id, action.title) };
    case "created":
      return {
        verb: "Created",
        target: action.title,
        summary: "New note",
        open: () => onOpenNote(action.note_id, action.title),
      };
    case "updated":
      return {
        verb: "Updated",
        target: action.title,
        summary: "Appended to the note",
        open: () => onOpenNote(action.note_id, action.title),
      };
    case "visited": {
      const size =
        typeof action.chars === "number"
          ? ` · ${plural(action.chars, "char")}${action.truncated ? ", truncated" : ""}`
          : "";
      return {
        verb: "Visited",
        target: shortUrl(action.url),
        summary: `${action.title}${size}`,
        // Only ever http(s): the server fetched it, but the link is still
        // rendered from stored data.
        href: /^https?:\/\//i.test(action.url) ? action.url : undefined,
      };
    }
    case "failed":
      return {
        verb: FAILED_VERB[action.tool] ?? action.tool,
        target: action.detail,
        summary: action.error || "Failed",
        failed: true,
      };
  }
}

const HEAD = "flex min-w-0 items-baseline gap-1.5 text-left";

function Step({ line }: { line: Line }) {
  const head = (
    <>
      <span className="shrink-0 font-semibold text-ob-text">{line.verb}</span>
      <span className="truncate text-ob-accent">{line.target}</span>
    </>
  );
  return (
    <li className="flex items-start gap-2">
      <span
        aria-hidden
        className={cn(
          "mt-[0.45em] size-1.5 shrink-0 rounded-full",
          line.failed ? "bg-red-400" : "bg-green-500",
        )}
      />
      <div className="min-w-0 flex-1">
        {line.open ? (
          <button type="button" onClick={line.open} className={cn(HEAD, "w-full hover:underline")}>
            {head}
          </button>
        ) : line.href ? (
          <a
            href={line.href}
            target="_blank"
            rel="noopener noreferrer"
            title={line.href}
            className={cn(HEAD, "hover:underline")}
          >
            {head}
          </a>
        ) : (
          <div className={HEAD}>{head}</div>
        )}
        {line.summary && (
          <p className={cn("truncate", line.failed ? "text-red-400" : "text-ob-faint")}>
            <span aria-hidden>└ </span>
            {line.summary}
          </p>
        )}
      </div>
    </li>
  );
}

export function AIToolSteps({
  actions,
  running,
  onOpenNote,
}: {
  actions: AIAction[];
  /** The step in progress, while a turn streams. */
  running?: string | null;
  onOpenNote: (id: string, title: string) => void;
}) {
  if (actions.length === 0 && !running) return null;
  return (
    <ol className="space-y-1 px-1 text-[12px]" aria-label="Assistant steps">
      {actions.map((action, i) => (
        <Step key={i} line={describe(action, onOpenNote)} />
      ))}
      {running && (
        <li className="flex items-center gap-2 text-ob-muted" aria-live="polite">
          <Loader2 className="size-3 shrink-0 animate-spin text-ob-accent" />
          {running}
        </li>
      )}
    </ol>
  );
}
