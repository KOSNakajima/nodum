"use client";

/**
 * The chat's settings button (bottom-left of the input) and its menu, after
 * Claude Code's: the model in use, thinking on/off, and the effort.
 *
 * The button names the effort while thinking is on, so it is never a guess
 * whether a reply was reasoned.
 */

import { ChevronRight, SlidersHorizontal } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { REASONING_EFFORTS, useAiChatSettingsStore } from "@/lib/stores/ai-chat-settings-store";
import { cn } from "@/lib/utils";

export function AiChatSettings({
  model,
  reasoningSupported,
  onOpenModelSettings,
}: {
  model: string;
  /** Whether the active provider takes a reasoning effort at all. */
  reasoningSupported: boolean;
  onOpenModelSettings: () => void;
}) {
  const thinking = useAiChatSettingsStore((s) => s.thinking);
  const effort = useAiChatSettingsStore((s) => s.effort);
  const setThinking = useAiChatSettingsStore((s) => s.setThinking);
  const setEffort = useAiChatSettingsStore((s) => s.setEffort);
  const effortLabel = REASONING_EFFORTS.find((e) => e.id === effort)?.label ?? "";
  const active = reasoningSupported && thinking;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Chat settings"
          className="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[11px] text-ob-faint hover:bg-ob-hover hover:text-ob-text"
        >
          <SlidersHorizontal className="size-3.5" strokeWidth={2} />
          {active && <span>{effortLabel}</span>}
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
          <button
            type="button"
            role="switch"
            aria-checked={active}
            aria-label="Thinking"
            disabled={!reasoningSupported}
            onClick={() => setThinking(!thinking)}
            className={cn(
              "relative ml-auto h-[18px] w-8 shrink-0 rounded-full transition-colors",
              active ? "bg-ob-accent" : "bg-ob-border",
            )}
          >
            <span
              className={cn(
                "absolute top-[3px] size-3 rounded-full bg-ob-text transition-[left]",
                active ? "left-[17px]" : "left-[3px]",
              )}
            />
          </button>
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
      </PopoverContent>
    </Popover>
  );
}
