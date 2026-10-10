"use client";

/**
 * AI chat panel — talk to your own model about your own vault.
 *
 * The key never comes near this component: every turn goes to the backend,
 * which decrypts the user's key, calls the provider, runs any vault tools the
 * model asked for, and returns the reply plus a record of what it changed.
 *
 * The transcript lives on the server, not here. Only the new message is sent;
 * the history comes back from the conversation, so a reload, a second device or
 * a cleared browser all keep the thread. Reopening the panel restores the chat
 * you were last in.
 *
 * Not configured is a first-class state, not an error: the panel explains what
 * is missing and opens the settings tab that fixes it.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, History, Plus, Send, Sparkles, Trash2 } from "lucide-react";
import { useRef, useState } from "react";

import { ReadingView } from "@/components/editor/reading-view";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { aiApi, noteApi } from "@/lib/api/endpoints";
import type { AIAction, AIConversationMessage, Note } from "@/lib/api/types";
import { useEditorSelectionStore, type EditorSelection } from "@/lib/stores/editor-selection-store";
import { AIToolSteps, ContextChip } from "./ai-tool-steps";
import { useWorkspaceStore } from "@/lib/stores/workspace-store";
import { toastError } from "@/lib/stores/toast-store";
import { cn } from "@/lib/utils";
import { isComposing } from "@/lib/ime";

const CONTEXT_CHARS = 4_000;
/** The API's cap on selected text. */
const SELECTION_CHARS = 20_000;

/** What goes along with a message: the open note, and lines selected in it. */
interface Attachment {
  noteId: string;
  title: string;
  lines: EditorSelection | null;
}

interface Outgoing {
  text: string;
  attach: Attachment | null;
}

/** The `context` record the server stores on the user's message — built here
 * too, so the optimistic copy shows it before the stored one arrives. */
function contextRecord(attach: Attachment): AIAction {
  return {
    kind: "context",
    title: attach.title,
    note_id: attach.noteId,
    ...(attach.lines ? { from_line: attach.lines.fromLine, to_line: attach.lines.toLine } : {}),
  };
}

export function AiChatPane({
  vaultId,
  noteId,
  onOpenNote,
}: {
  vaultId: string;
  noteId: string | null;
  onOpenNote: (noteId: string, title: string) => void;
}) {
  const queryClient = useQueryClient();
  const openSettings = useWorkspaceStore((s) => s.openSettings);
  const { data: status, isLoading } = useQuery({
    queryKey: ["ai-status", vaultId],
    queryFn: () => aiApi.status(vaultId),
  });

  // Which thread is showing, as an intent rather than an id — so "the most
  // recent one" survives the list loading, and "new chat" is not immediately
  // undone by it. Derived below; no effect syncs anything.
  type Selection = { mode: "auto" } | { mode: "new" } | { mode: "pick"; id: string };
  const [selection, setSelection] = useState<Selection>({ mode: "auto" });
  // Turns taken in this panel since the last load, layered over the stored
  // transcript so the reply appears without a refetch.
  const [pending, setPending] = useState<AIConversationMessage[]>([]);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  // The open note and the lines selected in it — shown above the input so it
  // is never a guess whether they go along, and sent with the message.
  const { data: openNote } = useQuery({
    queryKey: ["note", vaultId, noteId],
    queryFn: () => noteApi.get(vaultId, noteId as string),
    enabled: noteId !== null,
    gcTime: 60_000,
  });
  const editorSelection = useEditorSelectionStore((s) => s.selection);
  const selectedLines = editorSelection && editorSelection.noteId === noteId ? editorSelection : null;
  // × on the chip leaves this note (or this selection) out. Keyed by what the
  // chip shows, so selecting other lines or opening another note brings it back.
  const contextKey =
    noteId && openNote
      ? selectedLines
        ? `${noteId}:${selectedLines.fromLine}-${selectedLines.toLine}`
        : noteId
      : null;
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const attachment: Attachment | null =
    noteId && openNote && contextKey !== dismissedKey
      ? { noteId, title: openNote.title, lines: selectedLines }
      : null;
  const outgoing = (text: string): Outgoing => ({ text, attach: attachment });

  const configured = Boolean(status?.configured);
  const { data: conversations } = useQuery({
    queryKey: ["ai-conversations", vaultId],
    queryFn: () => aiApi.conversations(vaultId),
    enabled: configured,
  });
  // Reopening the panel returns to the thread you were last in — the point of
  // keeping history at all.
  const conversationId =
    selection.mode === "pick"
      ? selection.id
      : selection.mode === "new"
        ? null
        : (conversations?.[0]?.id ?? null);

  const { data: conversation } = useQuery({
    queryKey: ["ai-conversation", vaultId, conversationId],
    queryFn: () => aiApi.conversation(vaultId, conversationId as string),
    enabled: configured && conversationId !== null,
  });

  const messages: AIConversationMessage[] = [...(conversation?.messages ?? []), ...pending];

  const scrollToEnd = () => requestAnimationFrame(() => listRef.current?.scrollTo({ top: 1e6 }));

  // What the assistant is doing and saying right now, while the turn streams:
  // the reply grows word by word, finished tool calls pile up as steps, and the
  // one running shows as a spinner line.
  const [live, setLive] = useState<{ text: string; status: string | null; actions: AIAction[] }>({
    text: "",
    status: null,
    actions: [],
  });

  const send = useMutation({
    mutationFn: async ({ text, attach }: Outgoing) => {
      // The open note goes along as context, so "summarise this" works —
      // unless its chip was dismissed.
      const open = attach ? queryClient.getQueryData<Note>(["note", vaultId, attach.noteId]) : undefined;
      const context = open ? `# ${open.title}\n\n${open.content.slice(0, CONTEXT_CHARS)}` : "";
      return aiApi.vaultChatStream(
        vaultId,
        {
          message: text,
          conversation_id: conversationId ?? undefined,
          context,
          note_id: attach?.noteId,
          selection: attach?.lines
            ? {
                from_line: attach.lines.fromLine,
                to_line: attach.lines.toLine,
                text: attach.lines.text.slice(0, SELECTION_CHARS),
              }
            : undefined,
        },
        (event) => {
          if (event.type === "delta") {
            setLive((l) => ({ ...l, status: null, text: l.text + event.text }));
          } else if (event.type === "status") {
            setLive((l) => ({ ...l, status: event.text }));
          } else if (event.type === "action") {
            setLive((l) => ({ ...l, status: null, actions: [...l.actions, event.action] }));
          } else if (event.type === "reset") {
            setLive((l) => ({ ...l, text: "" }));
          }
          scrollToEnd();
        },
      );
    },
    onMutate: ({ text, attach }: Outgoing) => {
      setPending((m) => [...m, { role: "user", content: text, actions: attach ? [contextRecord(attach)] : [] }]);
      setLive({ text: "", status: null, actions: [] });
      setDraft("");
      scrollToEnd();
    },
    onSettled: () => setLive({ text: "", status: null, actions: [] }),
    onSuccess: (data) => {
      setPending((m) => [
        ...m,
        { role: "assistant", content: data.reply, actions: data.actions ?? [] },
      ]);
      // The turn is stored now; adopt its thread and let the queries catch up.
      setSelection({ mode: "pick", id: data.conversation_id });
      void queryClient.invalidateQueries({ queryKey: ["ai-conversations", vaultId] });
      void queryClient
        .invalidateQueries({ queryKey: ["ai-conversation", vaultId, data.conversation_id] })
        // Once the stored transcript includes this turn, the local copy would
        // double it.
        .then(() => setPending([]));
      const writes = (data.actions ?? []).filter(
        (a): a is AIAction & { kind: "created" | "updated" | "edited"; note_id: string } =>
          a.kind === "created" || a.kind === "updated" || a.kind === "edited",
      );
      if (writes.length > 0) {
        void queryClient.invalidateQueries({ queryKey: ["tree", vaultId] });
        void queryClient.invalidateQueries({ queryKey: ["graph", vaultId] });
        void queryClient.invalidateQueries({ queryKey: ["backlinks", vaultId] });
      }
      // A note the assistant changed may be open: refetching it is what lets
      // the editor adopt the new body (it does, unless you have unsaved typing).
      for (const write of writes) {
        if (write.kind !== "created") {
          void queryClient.invalidateQueries({ queryKey: ["note", vaultId, write.note_id] });
        }
      }
      scrollToEnd();
    },
    onError: (e, { text }) => {
      toastError(e, "The AI request failed.");
      // Nothing was stored, so drop the optimistic question and hand it back.
      setPending((m) => m.filter((msg) => msg.content !== text || msg.role !== "user"));
      setDraft(text);
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => aiApi.deleteConversation(vaultId, id),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: ["ai-conversations", vaultId] });
      if (id === conversationId) {
        setSelection({ mode: "auto" }); // fall back to the next most recent
        setPending([]);
      }
    },
    onError: (e) => toastError(e, "Could not delete that chat."),
  });

  if (isLoading) {
    return <p className="p-2 text-[13px] text-ob-faint">Loading…</p>;
  }

  if (!configured) {
    return (
      <div className="flex h-full flex-col items-start justify-center gap-3 p-4 text-[13px]">
        <Sparkles className="size-5 text-ob-accent" strokeWidth={1.75} />
        <p className="font-medium text-ob-text">AI is not set up yet</p>
        <p className="text-ob-muted">
          {status?.available === false
            ? "This server has no encryption key configured, so it cannot store an API key. Ask whoever runs it to set AI_ENCRYPTION_KEY."
            : "Nodum uses your own AI account. Add a key for Claude, OpenAI, Gemini or Qwen and this panel can search, write and link your notes."}
        </p>
        {status?.available !== false && (
          <Button size="sm" onClick={() => openSettings("AI")}>
            Set up AI
          </Button>
        )}
      </div>
    );
  }

  const startNewChat = () => {
    setSelection({ mode: "new" });
    setPending([]);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-ob-border px-1 pb-1.5 text-[11px] text-ob-faint">
        <span className="truncate">
          {status?.active_provider} · {status?.active_model}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Chat history"
                className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-ob-hover hover:text-ob-text"
              >
                <History className="size-3.5" strokeWidth={2} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-80 w-64 overflow-y-auto">
              <DropdownMenuLabel className="text-[11px] tracking-wide text-ob-faint uppercase">
                Chats in this vault
              </DropdownMenuLabel>
              {(conversations ?? []).length === 0 && (
                <p className="px-2 py-1.5 text-[12px] text-ob-faint">Nothing saved yet.</p>
              )}
              {(conversations ?? []).map((c) => (
                <DropdownMenuItem
                  key={c.id}
                  onSelect={() => {
                    setSelection({ mode: "pick", id: c.id });
                    setPending([]);
                    scrollToEnd();
                  }}
                >
                  {c.id === conversationId ? (
                    <Check className="mr-2 size-3.5 shrink-0 text-ob-accent" strokeWidth={2.5} />
                  ) : (
                    <span className="mr-2 w-3.5 shrink-0" aria-hidden />
                  )}
                  <span className="truncate">{c.title}</span>
                  <button
                    type="button"
                    aria-label={`Delete chat ${c.title}`}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      remove.mutate(c.id);
                    }}
                    className="ml-auto shrink-0 text-ob-faint hover:text-red-400"
                  >
                    <Trash2 className="size-3" strokeWidth={2} />
                  </button>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={startNewChat}>
                <Plus className="mr-2 size-3.5 shrink-0" strokeWidth={2} />
                New chat
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            aria-label="New chat"
            onClick={startNewChat}
            className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-ob-hover hover:text-ob-text"
          >
            <Plus className="size-3.5" strokeWidth={2} />
          </button>
        </div>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto py-2">
        {messages.length === 0 && (
          <p className="px-1 text-[13px] text-ob-faint">
            Ask about your notes, or ask for one to be written. It can search, read, create and
            extend notes in this vault, and open links you paste.
          </p>
        )}
        {messages.map((message, i) => (
          <div key={i} className="space-y-1.5">
            {/* The steps behind the answer come first, between the question and
                the reply — every tool call, never silent, and stored with the
                message so a restored thread shows them. */}
            <AIToolSteps actions={message.actions ?? []} onOpenNote={onOpenNote} />
            <p className="px-1 text-[11px] font-medium tracking-wide text-ob-faint uppercase">
              {message.role === "user" ? "You" : "Assistant"}
            </p>
            <div
              className={cn(
                "rounded-md px-2 py-1.5 text-[13px]",
                message.role === "user" ? "bg-ob-active text-ob-text" : "bg-ob-bg text-ob-muted",
              )}
              // The reading view sizes itself from the editor's font setting;
              // in a side panel it should match the panel.
              style={{ "--editor-font-size": "13px" } as React.CSSProperties}
            >
              {message.role === "assistant" ? (
                <ReadingView
                  content={message.content}
                  vaultId={vaultId}
                  onNavigate={() => undefined}
                />
              ) : (
                // A pasted URL has no break points; let it wrap anywhere
                // rather than push the panel into horizontal scroll.
                <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{message.content}</p>
              )}
            </div>
            {message.role === "user" &&
              (message.actions ?? []).map((action, k) =>
                action.kind === "context" ? (
                  <div key={k} className="px-1">
                    <ContextChip
                      title={action.title}
                      fromLine={action.from_line}
                      toLine={action.to_line}
                      onOpen={() => onOpenNote(action.note_id, action.title)}
                    />
                  </div>
                ) : null,
              )}
          </div>
        ))}
        {send.isPending && (
          <div className="space-y-1.5" data-testid="ai-live">
            <AIToolSteps actions={live.actions} running={live.status} onOpenNote={onOpenNote} />
            {live.text ? (
              <>
                <p className="px-1 text-[11px] font-medium tracking-wide text-ob-faint uppercase">Assistant</p>
                <div
                  className="rounded-md bg-ob-bg px-2 py-1.5 text-[13px] text-ob-muted"
                  style={{ "--editor-font-size": "13px" } as React.CSSProperties}
                >
                  <ReadingView content={live.text} vaultId={vaultId} onNavigate={() => undefined} />
                </div>
              </>
            ) : (
              !live.status && (
                <p className="px-1 text-[13px] text-ob-faint" aria-live="polite">
                  Thinking…
                </p>
              )
            )}
          </div>
        )}
      </div>

      <form
        // Focus is drawn on the box, matching the global :focus-visible ring
        // (2px accent, -1px offset) the textarea itself no longer shows.
        className="mt-2 rounded border border-ob-border bg-ob-bg focus-within:outline-2 focus-within:-outline-offset-1 focus-within:outline-ob-accent"
        onSubmit={(e) => {
          e.preventDefault();
          const text = draft.trim();
          if (text && !send.isPending) send.mutate(outgoing(text));
        }}
      >
        <textarea
          aria-label="Message the assistant"
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter is a newline — chat convention. The
            // Enter that confirms an IME conversion is neither.
            if (e.key === "Enter" && !e.shiftKey && !isComposing(e)) {
              e.preventDefault();
              const text = draft.trim();
              if (text && !send.isPending) send.mutate(outgoing(text));
            }
          }}
          placeholder="Ask about this vault…"
          // The box around it shows focus (focus-within); the global
          // :focus-visible ring is unlayered, so only !important removes it.
          className="block min-h-[3.5rem] w-full resize-none bg-transparent px-2 py-1.5 text-[13px] text-ob-text outline-none! placeholder:text-ob-faint"
        />
        {/* What the next message takes along, Claude Code style: the open note
            — or the lines selected in it — as a chip with an ×. */}
        <div className="flex items-center gap-1.5 px-1.5 pb-1.5" data-testid="ai-context">
          {attachment && contextKey && (
            <ContextChip
              title={attachment.title}
              fromLine={attachment.lines?.fromLine}
              toLine={attachment.lines?.toLine}
              onRemove={() => setDismissedKey(contextKey)}
            />
          )}
          <Button
            type="submit"
            size="sm"
            aria-label="Send"
            disabled={!draft.trim() || send.isPending}
            className="ml-auto"
          >
            <Send className="size-3.5" strokeWidth={2} />
          </Button>
        </div>
      </form>
    </div>
  );
}
