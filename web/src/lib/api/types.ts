/** API payload types mirroring back/app/schemas. */

export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  email_verified: boolean;
  /** Community moderation rights (pin/lock/delete, staff-only categories). */
  is_staff?: boolean;
  settings: Record<string, unknown>;
  created_at: string;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  user: User;
}

/** Signup's other answer: the address has to be confirmed before any token
 *  is issued. */
export interface VerificationRequired {
  status: "verification_required";
  email: string;
  expires_in_minutes: number;
}

export function isVerificationRequired(
  result: TokenPair | VerificationRequired,
): result is VerificationRequired {
  return (result as VerificationRequired).status === "verification_required";
}

export interface Vault {
  id: string;
  name: string;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface FolderInfo {
  id: string;
  parent_id: string | null;
  name: string;
  path: string;
}

export interface NoteMeta {
  id: string;
  folder_id: string | null;
  title: string;
  path: string;
  word_count: number;
  properties: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Note extends NoteMeta {
  content: string;
}

export type TreeItem =
  | { type: "folder"; id: string; name: string; path: string; children: TreeItem[] }
  | {
      type: "note";
      id: string;
      title: string;
      path: string;
      created_at: string;
      updated_at: string;
    };

export interface VaultTree {
  truncated?: boolean;
  vault_id: string;
  items: TreeItem[];
}

export interface Backlink {
  note_id: string;
  title: string;
  path: string;
  count: number;
  snippets: string[];
}

export interface OutgoingLink {
  target_title: string;
  target_note_id: string | null;
  resolved_title: string | null;
  resolved_path: string | null;
  is_embed: boolean;
  count: number;
}

export interface UnlinkedMention {
  note_id: string;
  title: string;
  path: string;
  snippets: string[];
}

export interface GraphNode {
  id: string;
  title: string;
  path: string;
  folder: string;
  degree: number;
  unresolved: boolean;
  tags: string[];
  /** ISO time; null for ghost nodes. */
  created_at: string | null;
}

export interface Graph {
  /** Set when the server capped the payload (huge vault). */
  truncated?: boolean;
  vault_id: string;
  nodes: GraphNode[];
  edges: [number, number][];
  center?: string;
}

export interface SearchResult {
  id: string;
  title: string;
  path: string;
  snippet: string;
  rank: number;
  created_at: string;
  updated_at: string;
}

export interface QuickSwitchResult {
  id: string;
  title: string;
  path: string;
  score: number;
  /** Present when the match came through a frontmatter alias. */
  alias?: string;
}

export interface NoteVersionMeta {
  id: string;
  title: string;
  created_at: string;
  size_chars: number;
}

export interface NoteVersionDetail extends NoteVersionMeta {
  content: string;
}

export interface TagCount {
  name: string;
  count: number;
}

export interface AttachmentInfo {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
}

// ── Canvas (JSON Canvas format) ─────────────────────────────────────────────

export interface CanvasNode {
  id: string;
  type: "text" | "file" | "link";
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  file?: string;
  url?: string;
  color?: string;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: "top" | "right" | "bottom" | "left";
  toSide?: "top" | "right" | "bottom" | "left";
  label?: string;
}

export interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export interface CanvasMeta {
  id: string;
  name: string;
  updated_at: string;
}

export interface CanvasFull extends CanvasMeta {
  data: CanvasData;
}

// ── AI (bring your own key) ──────────────────────────────────────────────────

export interface AIProviderInfo {
  id: string;
  label: string;
  default_model: string;
  models: string[];
  key_url: string;
}

/** Never carries an API key — only a hint like `sk-ant…7f2a`. */
export interface AICredentialInfo {
  provider: string;
  model: string;
  key_hint: string;
  base_url: string;
}

/** One scope's keys: the account's (every vault) or one vault's own. */
export interface AIScopeStatus {
  configured: boolean;
  active_provider: string | null;
  active_model: string;
  reasoning_supported: boolean;
  credentials: AICredentialInfo[];
}

export interface AIStatus {
  /** False when the server has no encryption key, so keys cannot be stored. */
  available: boolean;
  /** What chat in the asked-for context uses: the vault's own keys when it
   *  has any, the account's otherwise. */
  configured: boolean;
  active_provider: string | null;
  active_model: string;
  /** Whether the chat's thinking controls apply to the active provider. */
  reasoning_supported: boolean;
  /** The account's keys (kept at the top level for older callers). */
  credentials: AICredentialInfo[];
  account: AIScopeStatus;
  /** Present when the status was asked for a vault. */
  vault: AIScopeStatus | null;
  effective_scope: "vault" | "account" | null;
  providers: AIProviderInfo[];
}

/** One tool call the assistant made during a turn, as stored with the reply —
 * or, on a user message, the `context` that went along with it (the open note
 * and any selected lines). Messages from before every call was recorded hold
 * only created/updated. */
export type AIAction =
  | { kind: "created" | "updated" | "read"; title: string; note_id: string }
  | { kind: "edited"; title: string; note_id: string; removed: number; added: number }
  | { kind: "context"; title: string; note_id: string; from_line?: number; to_line?: number }
  /** One round of thinking: how long, and the model's summary of it. */
  | { kind: "thought"; seconds: number; text: string }
  | { kind: "searched"; query: string; count: number }
  | { kind: "visited"; title: string; url: string; chars?: number; truncated?: boolean }
  | { kind: "failed"; tool: string; detail: string; error: string };

export interface AIChatReply {
  reply: string;
  provider: string;
  model: string;
  actions?: AIAction[];
  /** The thread this turn was appended to — a new one when none was sent. */
  conversation_id: string;
  title: string;
}

/** One vault chat turn. `note_id` and `selection` say what the user was
 * looking at; the server records them on the message and shows the model the
 * selected lines. */
export interface AIVaultChatRequest {
  message: string;
  conversation_id?: string;
  context?: string;
  note_id?: string;
  /** 1-based, inclusive. */
  selection?: { from_line: number; to_line: number; text: string };
  /** Thinking on, at this effort; omitted = off (the model's own default). */
  reasoning_effort?: "low" | "medium" | "high" | "xhigh";
}

/** One server-sent event of a streamed vault chat turn. */
export type AIStreamEvent =
  | { type: "status"; text: string; tool?: string }
  | { type: "delta"; text: string }
  /** A piece of the reasoning summary, while the model thinks. */
  | { type: "thinking"; text: string }
  | { type: "action"; action: AIAction }
  | { type: "reset" }
  | ({ type: "done" } & AIChatReply)
  | { type: "error"; code?: string; message: string };

export interface AIConversationMeta {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface AIConversationMessage {
  role: "user" | "assistant";
  content: string;
  actions: AIAction[];
}

export interface AIConversationDetail {
  id: string;
  title: string;
  updated_at: string;
  messages: AIConversationMessage[];
}

// ── MCP tokens ───────────────────────────────────────────────────────────────

/** A minted token, minus the token itself (only the create response has it). */
export interface McpToken {
  id: string;
  kind: string;
  name: string;
  hint: string;
  created_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface McpTokenList {
  tokens: McpToken[];
  /** The URL an MCP client should be pointed at. */
  endpoint: string;
}

// ── API keys ─────────────────────────────────────────────────────────────────

/** A minted API key, minus the key itself (only the create response has it). */
export interface ApiKey {
  id: string;
  kind: string;
  name: string;
  scopes: string[];
  hint: string;
  created_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface ApiKeyList {
  keys: ApiKey[];
  /** The public API's base URL — what a program calls. */
  base_url: string;
}

export type ApiKeyWithToken = ApiKey & { token: string; base_url: string };

// ── Community ────────────────────────────────────────────────────────────────

export interface CommunityReportItem {
  id: string;
  post_id: string;
  topic_id: string;
  topic_title: string;
  post_number: number;
  post_excerpt: string;
  reason: string;
  detail: string | null;
  reporter: string | null;
  status: string;
  created_at: string;
}

