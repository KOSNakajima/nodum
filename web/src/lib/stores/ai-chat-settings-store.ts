"use client";

/**
 * The AI panel's own preferences — thinking on/off and its effort — kept per
 * browser like Claude Code's session settings. Off sends nothing, so the model
 * runs at its own default; on sends `reasoning_effort` with each message.
 * Connected MCP servers are on unless switched off here, per browser too.
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export const REASONING_EFFORTS: { id: ReasoningEffort; label: string }[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Max" },
];

interface AiChatSettingsState {
  thinking: boolean;
  effort: ReasoningEffort;
  /** MCP servers switched off for the chat, by id. A new server starts on. */
  mcpOff: string[];
  setThinking: (on: boolean) => void;
  setEffort: (effort: ReasoningEffort) => void;
  setMcpServerOn: (id: string, on: boolean) => void;
}

export const useAiChatSettingsStore = create<AiChatSettingsState>()(
  persist(
    (set) => ({
      thinking: false,
      effort: "medium",
      mcpOff: [],
      setThinking: (thinking) => set({ thinking }),
      setEffort: (effort) => set({ effort }),
      setMcpServerOn: (id, on) =>
        set((s) => ({ mcpOff: on ? s.mcpOff.filter((x) => x !== id) : [...new Set([...s.mcpOff, id])] })),
    }),
    {
      name: "nodum-ai-chat-settings",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ thinking: s.thinking, effort: s.effort, mcpOff: s.mcpOff }),
    },
  ),
);
