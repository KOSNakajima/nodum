import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * True while an IME (Japanese, Chinese, Korean…) is composing text.
 *
 * The Enter that confirms a conversion arrives as an ordinary keydown, so a
 * handler that submits or commits on Enter must ignore it — otherwise the
 * half-converted text is sent. `isComposing` covers Chrome and Firefox;
 * Safari fires that keydown after `compositionend` with `isComposing` false,
 * and only `keyCode` 229 identifies it there.
 */
export function isComposing(event: KeyboardEvent | ReactKeyboardEvent): boolean {
  const native = "nativeEvent" in event ? event.nativeEvent : event;
  return native.isComposing || native.keyCode === 229;
}
