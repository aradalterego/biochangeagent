export interface ChatCitation {
  label: string;
  sourceId: string;
  chunkId: string;
  title: string;
  sourceType: string;
  authorityLevel: number;
  section: string | null;
  page: number | null;
  version: string | null;
  excerpt: string;
}

export type ChatPendingAction =
  | { type: "confirm_order"; orderId: string; summary: string }
  | { type: "open_case"; caseId: string; summary: string };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  sources: ChatCitation[];
  pendingActions: ChatPendingAction[];
  error?: boolean;
  createdAt: string;
}
