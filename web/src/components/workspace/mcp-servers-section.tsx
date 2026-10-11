"use client";

/**
 * Settings → MCP → MCP servers: remote tool servers the AI chat may call
 * (a web search service, say). Nodum is the client here — the other half of
 * the tab is Nodum as a server.
 *
 * Adding a server connects to it straight away and lists its tools, so a bad
 * URL or token shows up on this form, not mid-chat. The token goes in and is
 * never shown again, only its hint. Each tool can be switched off; one the
 * server adds later starts off.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { mcpServersApi } from "@/lib/api/endpoints";
import type { McpServer, McpServerUpdate } from "@/lib/api/types";
import { toastError, useToastStore } from "@/lib/stores/toast-store";
import { cn } from "@/lib/utils";

const QUERY_KEY = ["mcp-servers"];

interface Draft {
  name: string;
  url: string;
  token: string;
}

/** Name, URL and token — for adding a server and for editing one. */
function ServerForm({
  initial,
  editing,
  pending,
  onSubmit,
  onCancel,
}: {
  initial: Draft;
  /** Editing keeps the stored token when the field is left empty. */
  editing: boolean;
  pending: boolean;
  onSubmit: (draft: Draft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const id = editing ? "mcp-server-edit" : "mcp-server-new";
  return (
    <form
      className="space-y-2 rounded-md border border-ob-border bg-ob-bg p-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!pending) onSubmit(draft);
      }}
    >
      <div className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
        <Label htmlFor={`${id}-name`}>Name</Label>
        <Input
          id={`${id}-name`}
          className="h-8"
          placeholder="My MCP server"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
        <Label htmlFor={`${id}-url`}>URL</Label>
        <Input
          id={`${id}-url`}
          className="h-8 font-mono text-[12px]"
          placeholder="https://example.com/mcp"
          value={draft.url}
          onChange={(e) => setDraft({ ...draft, url: e.target.value })}
        />
        <Label htmlFor={`${id}-token`}>Token</Label>
        <Input
          id={`${id}-token`}
          type="password"
          autoComplete="off"
          className="h-8 font-mono text-[12px]"
          placeholder={editing ? "Leave empty to keep the current token" : "Optional — sent as Authorization: Bearer"}
          value={draft.token}
          onChange={(e) => setDraft({ ...draft, token: e.target.value })}
        />
      </div>
      <p className="text-[11px] text-ob-faint">
        Put an API key in Token rather than in the URL: the token is stored encrypted and never shown again.
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={pending || !draft.name.trim() || !draft.url.trim()}>
          {pending ? "Connecting…" : editing ? "Save" : "Connect"}
        </Button>
      </div>
    </form>
  );
}

function ToolSwitch({ checked, label, onChange }: { checked: boolean; label: string; onChange: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={cn(
        "relative h-[18px] w-8 shrink-0 rounded-full transition-colors",
        checked ? "bg-ob-accent" : "bg-ob-border",
      )}
    >
      <span
        className={cn(
          "absolute top-[3px] size-3 rounded-full bg-ob-text transition-[left]",
          checked ? "left-[17px]" : "left-[3px]",
        )}
      />
    </button>
  );
}

function ServerCard({ server }: { server: McpServer }) {
  const queryClient = useQueryClient();
  const toast = useToastStore((s) => s.push);
  const [editing, setEditing] = useState(false);
  const update = useMutation({
    mutationFn: (body: McpServerUpdate) => mcpServersApi.update(server.id, body),
    onSuccess: (saved) => {
      queryClient.setQueryData<McpServer[]>(QUERY_KEY, (list) => list?.map((s) => (s.id === saved.id ? saved : s)));
      setEditing(false);
    },
    onError: (e) => toastError(e, "Could not update the server."),
  });
  const remove = useMutation({
    mutationFn: () => mcpServersApi.remove(server.id),
    onSuccess: () => {
      queryClient.setQueryData<McpServer[]>(QUERY_KEY, (list) => list?.filter((s) => s.id !== server.id));
      toast(`${server.name} removed.`, "info");
    },
    onError: (e) => toastError(e, "Could not remove the server."),
  });
  const enabled = new Set(server.enabled_tools);
  const toggle = (name: string) =>
    update.mutate({
      enabled_tools: server.tools.map((t) => t.name).filter((n) => (n === name ? !enabled.has(n) : enabled.has(n))),
    });

  return (
    <li className="rounded-md border border-ob-border bg-ob-bg" data-testid="mcp-server">
      <div className="flex flex-wrap items-center gap-2 border-b border-ob-border px-2.5 py-2">
        <span className="font-medium text-ob-text">{server.name}</span>
        <span className="flex items-center gap-1 text-[11px] text-green-500">
          <span aria-hidden className="size-1.5 rounded-full bg-green-500" />
          Connected · {server.tools.length} {server.tools.length === 1 ? "tool" : "tools"}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          aria-label={`Reload the tools of ${server.name}`}
          title="Reload tools"
          disabled={update.isPending}
          onClick={() => update.mutate({ refresh: true })}
          className="flex size-6 items-center justify-center rounded text-ob-faint hover:bg-ob-hover hover:text-ob-text"
        >
          <RefreshCw className={cn("size-3.5", update.isPending && "animate-spin")} strokeWidth={2} />
        </button>
        <button
          type="button"
          aria-label={`Edit ${server.name}`}
          onClick={() => setEditing((v) => !v)}
          className="flex size-6 items-center justify-center rounded text-ob-faint hover:bg-ob-hover hover:text-ob-text"
        >
          <Pencil className="size-3.5" strokeWidth={2} />
        </button>
        <button
          type="button"
          aria-label={`Remove ${server.name}`}
          onClick={() => remove.mutate()}
          className="flex size-6 items-center justify-center rounded text-ob-faint hover:text-red-400"
        >
          <Trash2 className="size-3.5" strokeWidth={2} />
        </button>
      </div>

      {editing ? (
        <div className="p-2">
          <ServerForm
            editing
            initial={{ name: server.name, url: server.url, token: "" }}
            pending={update.isPending}
            onCancel={() => setEditing(false)}
            onSubmit={(d) =>
              update.mutate({
                name: d.name,
                ...(d.url.trim() !== server.url ? { url: d.url } : {}),
                ...(d.token.trim() ? { token: d.token } : {}),
              })
            }
          />
        </div>
      ) : (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 px-2.5 py-2 text-[12px]">
          <dt className="text-ob-faint">URL</dt>
          <dd className="font-mono [overflow-wrap:anywhere] text-ob-muted">{server.url}</dd>
          <dt className="text-ob-faint">Token</dt>
          <dd className="font-mono text-ob-muted">{server.token_hint || "None"}</dd>
        </dl>
      )}

      {server.tools.length > 0 && (
        <ul className="divide-y divide-ob-border border-t border-ob-border px-2.5" aria-label={`Tools of ${server.name}`}>
          {server.tools.map((tool) => (
            <li key={tool.name} className="flex items-center gap-3 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="font-mono text-[12px] text-ob-text">{tool.name}</p>
                {tool.description && (
                  <p className="line-clamp-2 text-[11.5px] text-ob-faint" title={tool.description}>
                    {tool.description}
                  </p>
                )}
              </div>
              <ToolSwitch
                checked={enabled.has(tool.name)}
                label={`Let the chat use ${tool.name}`}
                onChange={() => toggle(tool.name)}
              />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function McpServersSection() {
  const queryClient = useQueryClient();
  const toast = useToastStore((s) => s.push);
  const { data: servers } = useQuery({ queryKey: QUERY_KEY, queryFn: mcpServersApi.list });
  const [adding, setAdding] = useState(false);
  const create = useMutation({
    mutationFn: (d: Draft) =>
      mcpServersApi.create({ name: d.name.trim(), url: d.url.trim(), token: d.token.trim() || undefined }),
    onSuccess: (saved) => {
      queryClient.setQueryData<McpServer[]>(QUERY_KEY, (list) => [...(list ?? []), saved]);
      setAdding(false);
      toast(`${saved.name} connected.`, "info");
    },
    onError: (e) => toastError(e, "Could not connect to the server."),
  });

  return (
    <section className="space-y-2" aria-labelledby="mcp-servers-heading">
      <h3 id="mcp-servers-heading" className="text-[11px] font-medium tracking-wide text-ob-faint uppercase">
        MCP servers
      </h3>
      <p className="text-[12px] text-ob-faint">
        Remote tool servers the AI chat can call — a web search service, for example. The chat runs their tools from
        this server, so tokens never reach the browser; turn a server on or off for a chat in its ⚙ menu.
      </p>

      {(servers ?? []).length > 0 && (
        <ul className="space-y-2">
          {servers?.map((server) => (
            <ServerCard key={server.id} server={server} />
          ))}
        </ul>
      )}

      {adding ? (
        <ServerForm
          editing={false}
          initial={{ name: "", url: "", token: "" }}
          pending={create.isPending}
          onCancel={() => setAdding(false)}
          onSubmit={(d) => create.mutate(d)}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex w-full items-center gap-1.5 rounded-md border border-dashed border-ob-border px-2.5 py-2 text-left text-[12px] text-ob-faint hover:border-ob-faint hover:text-ob-text"
        >
          <Plus className="size-3.5" strokeWidth={2} />
          Add MCP server
        </button>
      )}
    </section>
  );
}
