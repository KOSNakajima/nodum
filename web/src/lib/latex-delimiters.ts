/**
 * `\( … \)` and `\[ … \]` → `$ … $` and `$$ … $$`, outside code.
 *
 * The reading view's math (remark-math) reads dollar delimiters only, while
 * OpenAI models write LaTeX's own by default — ChatGPT renders those. The AI
 * panel runs replies through this so either reads as math. Notes do not: in
 * markdown `\(` is an escaped parenthesis, and a note means what it says.
 */

const CODE_SPLIT = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g;

export function latexDelimitersToDollars(md: string): string {
  return md
    .split(CODE_SPLIT)
    .map((chunk, i) => {
      if (i % 2 === 1) return chunk; // code — literal
      return chunk
        .replace(/\\\[([\s\S]+?)\\\]/g, (_m, body: string) => `\n$$\n${body.trim()}\n$$\n`)
        .replace(/\\\(([\s\S]+?)\\\)/g, (_m, body: string) => `$${body.trim()}$`);
    })
    .join("");
}
