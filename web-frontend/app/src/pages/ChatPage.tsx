import { useState, useEffect, useRef, useCallback } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import {
  sendChatMessage,
  fetchConversations,
  ApiError,
} from "../utils/api";
import type { ChatMessage, ConversationSummary } from "../utils/api";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(iso?: string): string {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return "";
  }
}

// ─── Components ───────────────────────────────────────────────────────────────

interface MessageBubbleProps {
  msg: ChatMessage;
}

function MessageBubble({ msg }: MessageBubbleProps) {
  const isUser = msg.role === "user";
  return (
    <div className={`chat-bubble-row ${isUser ? "chat-bubble-row--user" : "chat-bubble-row--assistant"}`}>
      {!isUser && (
        <div className="chat-avatar chat-avatar--assistant" aria-hidden="true">
          🐾
        </div>
      )}
      <div className={`chat-bubble ${isUser ? "chat-bubble--user" : "chat-bubble--assistant"}`}>
        <p className="chat-bubble-text">{msg.content}</p>
        {msg.timestamp && (
          <span className="chat-bubble-time">{formatTime(msg.timestamp)}</span>
        )}
      </div>
      {isUser && (
        <div className="chat-avatar chat-avatar--user" aria-hidden="true">
          👤
        </div>
      )}
    </div>
  );
}

interface HistorySidebarProps {
  summaries: ConversationSummary[];
  loading: boolean;
  error: string | null;
}

function HistorySidebar({ summaries, loading, error }: HistorySidebarProps) {
  return (
    <aside className="chat-sidebar">
      <h2 className="chat-sidebar-title">Past Conversations</h2>

      {loading && (
        <p className="chat-sidebar-state">Loading history…</p>
      )}

      {!loading && error && (
        <p className="chat-sidebar-state chat-sidebar-state--error">{error}</p>
      )}

      {!loading && !error && summaries.length === 0 && (
        <p className="chat-sidebar-state">No previous conversations yet.</p>
      )}

      {!loading && !error && summaries.length > 0 && (
        <ul className="chat-sidebar-list">
          {summaries.map((s, i) => (
            <li key={s.id ?? i} className="chat-sidebar-item">
              {s.date && (
                <span className="chat-sidebar-date">{s.date}</span>
              )}
              <p className="chat-sidebar-summary">{s.summary}</p>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ChatPage() {
  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Conversation history sidebar
  const [historySummaries, setHistorySummaries] = useState<ConversationSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Auto-scroll
  const bottomRef = useRef<HTMLDivElement>(null);

  // ── Load conversation history on mount ──────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setHistoryLoading(true);
      setHistoryError(null);
      try {
        const data = await fetchConversations();
        if (!cancelled) {
          setHistorySummaries(data.conversations ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          if (err instanceof ApiError && err.status === 404) {
            // Endpoint doesn't exist yet — fail silently
            setHistorySummaries([]);
          } else {
            setHistoryError(
              err instanceof Error ? err.message : "Failed to load history",
            );
          }
        }
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // ── Auto-scroll to latest message ───────────────────────────────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isSending]);

  // ── Send message ────────────────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isSending) return;

    const userMsg: ChatMessage = {
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsSending(true);
    setSendError(null);

    try {
      // Pass the current history (excluding the new message — backend appends it)
      const res = await sendChatMessage(text, messages);

      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: res.response,
        timestamp: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, assistantMsg]);

      // If the backend returns an updated history, trust it
      if (res.history && res.history.length > 0) {
        setMessages(res.history.map((m) => ({
          ...m,
          timestamp: m.timestamp ?? new Date().toISOString(),
        })));
      }
    } catch (err) {
      setSendError(
        err instanceof Error ? err.message : "Failed to send message",
      );
      // Revert the optimistic user message
      setMessages((prev) => prev.slice(0, -1));
      setInput(text);
    } finally {
      setIsSending(false);
    }
  }, [input, isSending, messages]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFormSubmit = (e: FormEvent) => {
    e.preventDefault();
    handleSend();
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="chat-page">
      {/* ── Mobile sidebar toggle ── */}
      <button
        className="chat-sidebar-toggle"
        onClick={() => setSidebarOpen((o) => !o)}
        aria-label={sidebarOpen ? "Close history" : "Open history"}
      >
        {sidebarOpen ? "✕" : "🕐 History"}
      </button>

      {/* ── Sidebar ── */}
      <div className={`chat-sidebar-wrapper ${sidebarOpen ? "chat-sidebar-wrapper--open" : ""}`}>
        <HistorySidebar
          summaries={historySummaries}
          loading={historyLoading}
          error={historyError}
        />
      </div>

      {/* ── Main chat area ── */}
      <main className="chat-main">
        <header className="chat-header">
          <h1 className="chat-title">OpenClaw Chat</h1>
          <p className="chat-subtitle">Memory-backed · Ask me anything</p>
        </header>

        {/* Message list */}
        <div className="chat-messages" role="log" aria-live="polite" aria-label="Conversation">
          {messages.length === 0 && !isSending && (
            <div className="chat-empty">
              <p>No messages yet. Start the conversation below.</p>
            </div>
          )}

          {messages.map((msg, i) => (
            <MessageBubble key={i} msg={msg} />
          ))}

          {isSending && (
            <div className="chat-bubble-row chat-bubble-row--assistant">
              <div className="chat-avatar chat-avatar--assistant" aria-hidden="true">🐾</div>
              <div className="chat-bubble chat-bubble--assistant chat-bubble--typing">
                <span className="chat-typing-dot" />
                <span className="chat-typing-dot" />
                <span className="chat-typing-dot" />
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Error banner */}
        {sendError && (
          <div className="chat-error" role="alert">
            <span>{sendError}</span>
            <button
              className="chat-error-dismiss"
              onClick={() => setSendError(null)}
              aria-label="Dismiss error"
            >
              ✕
            </button>
          </div>
        )}

        {/* Input area */}
        <form className="chat-input-area" onSubmit={handleFormSubmit} noValidate>
          <textarea
            className="chat-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message OpenClaw… (Enter to send, Shift+Enter for newline)"
            rows={3}
            disabled={isSending}
            aria-label="Message input"
          />
          <button
            className="chat-send-btn"
            type="submit"
            disabled={isSending || !input.trim()}
            aria-label="Send message"
          >
            {isSending ? (
              <span className="chat-send-spinner" aria-hidden="true" />
            ) : (
              "Send"
            )}
          </button>
        </form>
      </main>
    </div>
  );
}
