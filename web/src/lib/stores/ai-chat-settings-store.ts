"use client";

/**
 * The AI panel's own preferences — thinking on/off and its effort — kept per
 * browser like Claude Code's session settings. Off sends nothing, so the model
 * runs at its own default; on sends `reasoning_effort` with each message.
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
  setThinking: (on: boolean) => void;
  setEffort: (effort: ReasoningEffort) => void;
}

export const useAiChatSettingsStore = create<AiChatSettingsState>()(
  persist(
    (set) => ({
      thinking: false,
      effort: "medium",
      setThinking: (thinking) => set({ thinking }),
      setEffort: (effort) => set({ effort }),
    }),
    {
      name: "nodum-ai-chat-settings",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ thinking: s.thinking, effort: s.effort }),
    },
  ),
);
