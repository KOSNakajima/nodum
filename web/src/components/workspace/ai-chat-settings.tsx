"use client";

/**
 * The chat's settings button (bottom-left of the input) and its menu, after
 * Claude Code's: the model in use, thinking on/off, the effort, and which
 * connected MCP servers the chat may call. The button is the same gear as the
 * ribbon's settings, with no label beside it — what is on lives in the menu.
 */

import { ChevronRight, Plus, Settings as SettingsIcon } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { McpServer } from "@/lib/api/types";
import { REASONING_EFFORTS, useAiChatSettingsStore } from "@/lib/stores/ai-chat-settings-store";
import { cn } from "@/lib/utils";

export function AiChatSettings({
  model,
  reasoningSupported,
  onOpenModelSettings,
  mcpServers,
  onOpenMcpSettings,
}: {
  model: string;
  /** Whether the active provider takes a reasoning effort at all. */
  reasoningSupported: boolean;
  onOpenModelSettings: () => void;
  /** Connected in Settings → MCP; each is switched on or off here. */
  mcpServers: McpServer[];
  onOpenMcpSettings: () => void;
}) {
  const thinking = useAiChatSettingsStore((s) => s.thinking);
  const effort = useAiChatSettingsStore((s) => s.effort);
  const setThinking = useAiChatSettingsStore((s) => s.setThinking);
  const setEffort = useAiChatSettingsStore((s) => s.setEffort);
  const effortLabel = REASONING_EFFORTS.find((e) => e.id === effort)?.label ?? "";
  const active = reasoningSupported && thinking;
  const mcpOff = useAiChatSettingsStore((s) => s.mcpOff);
  const setMcpServerOn = useAiChatSettingsStore((s) => s.setMcpServerOn);
  // A server with every tool switched off in Settings has nothing to offer.
  const usable = (server: McpServer) => server.enabled_tools.length > 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Chat settings"
          className="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[11px] text-ob-faint hover:bg-ob-hover hover:text-ob-text"
        >
          <SettingsIcon className="size-3.5" strokeWidth={2} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-64 gap-0 border-ob-border bg-ob-sidebar p-1 text-[13px] text-ob-text"
      >
        <p className="px-2 pt-1 pb-1.5 text-[11px] text-ob-faint">Model</p>
        <button
          type="button"
          onClick={onOpenModelSettings}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-ob-hover"
        >
          <span>Switch model…</span>
          <span className="ml-auto truncate text-ob-faint">{model}</span>
          <ChevronRight className="size-3.5 shrink-0 text-ob-faint" strokeWidth={2} />
        </button>

        <div className={cn("flex items-center gap-2 px-2 py-1.5", !reasoningSupported && "opacity-50")}>
          <span>Thinking</span>
          <Switch
            label="Thinking"
            checked={active}
            disabled={!reasoningSupported}
            onChange={() => setThinking(!thinking)}
          />
        </div>

        <div className={cn("flex items-center gap-2 px-2 py-1.5", !active && "opacity-50")}>
          <span>
            Effort <span className="text-ob-faint">({effortLabel})</span>
          </span>
          <div className="ml-auto flex items-center gap-0.5 rounded-full bg-ob-bg px-1 py-0.5" role="group" aria-label="Effort">
            {REASONING_EFFORTS.map((level) => (
              <button
                key={level.id}
                type="button"
                aria-label={`Effort ${level.label}`}
                aria-pressed={effort === level.id}
                disabled={!active}
                onClick={() => setEffort(level.id)}
                className="flex size-4 items-center justify-center"
              >
                <span
                  className={cn(
                    "rounded-full",
                    effort === level.id ? "size-3 bg-ob-text" : "size-1 bg-ob-faint",
                  )}
                />
              </button>
            ))}
          </div>
        </div>

        {!reasoningSupported && (
          <p className="px-2 pt-0.5 pb-1.5 text-[11px] text-ob-faint">
            Thinking settings work with OpenAI-compatible models (Azure included) for now.
          </p>
        )}

        <div className="my-1 border-t border-ob-border" />
        <p className="px-2 pt-1 pb-1.5 text-[11px] text-ob-faint">MCP servers</p>
        {mcpServers.map((server) => {
          const on = usable(server) && !mcpOff.includes(server.id);
          return (
            <div
              key={server.id}
              className={cn("flex items-center gap-2 px-2 py-1.5", !usable(server) && "opacity-50")}
              title={usable(server) ? undefined : "Every tool of this server is off in Settings → MCP"}
            >
              <span className="truncate">{server.name}</span>
              <Switch
                label={`Use ${server.name}`}
                checked={on}
                disabled={!usable(server)}
                onChange={() => setMcpServerOn(server.id, !on)}
              />
            </div>
          );
        })}
        <button
          type="button"
          onClick={onOpenMcpSettings}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-ob-faint hover:bg-ob-hover hover:text-ob-text"
        >
          <Plus className="size-3.5 shrink-0" strokeWidth={2} />
          <span>{mcpServers.length ? "Manage MCP servers…" : "Add an MCP server…"}</span>
        </button>
      </PopoverContent>
    </Popover>
  );
}

function Switch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        "relative ml-auto h-[18px] w-8 shrink-0 rounded-full transition-colors",
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
