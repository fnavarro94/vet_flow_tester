// src/testers/VetChatTester.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { RELAY_BASE } from "../config";
import { useAuth } from "../auth/AuthContext.jsx";
import LoginBox from "../components/LoginBox.jsx";

/* ───────────────────── Markdown helpers ───────────────────── */
marked.setOptions({ gfm: true, breaks: true });
const mdToHtml = (s = "") =>
  DOMPurify.sanitize(marked.parse ? marked.parse(s) : marked(s), {
    USE_PROFILES: { html: true },
  });

const escapeHtml = (s = "") =>
  String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// Strip any internal hidden-cite tokens if they ever slip through
const INTERNAL_CITE_RE = /\uE200cite\uE202[\s\S]*?\uE201/g;
const stripInternalCites = (s = "") => String(s).replace(INTERNAL_CITE_RE, "");

/* ───────────────────── Citations ───────────────────── */
function PerChunkCites({ citations = [] }) {
  if (!Array.isArray(citations) || citations.length === 0) return null;
  return (
    <ol className="vc-cites">
      {citations.map((c, i) => {
        const url = (c?.url || "").trim();
        const title = c?.title || url || "Fuente";
        return (
          <li key={i}>
            {url ? (
              <a href={url} target="_blank" rel="noopener">
                {title}
              </a>
            ) : (
              <span>{title}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function GlobalCites({ citations = [] }) {
  if (!Array.isArray(citations) || citations.length === 0) return null;
  return (
    <div className="vc-global-cites">
      <div className="vc-structured-title" style={{ marginTop: 12 }}>Fuentes</div>
      <ol className="vc-cites">
        {citations.map((c, i) => {
          const url = (c?.url || "").trim();
          const title = c?.title || url || "Fuente";
          return (
            <li key={i}>
              {url ? (
                <a href={url} target="_blank" rel="noopener">
                  {title}
                </a>
              ) : (
                <span>{title}</span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/* ───────────────────── Structured blocks ───────────────────── */
const SEVERITY_CLASS = { info: "info", warning: "warning", danger: "danger" };

function StructuredBlock({ chunk, index }) {
  if (!chunk) return null;
  const kind = String(chunk.kind || "paragraph").toLowerCase();
  const title = chunk.title || "";
  const text = chunk.text || "";
  const items = Array.isArray(chunk.items) ? chunk.items.filter(Boolean) : [];
  const table = chunk.table || null;

  const wrap = (child, extraClass = "") => (
    <div className={`vc-structured-block ${kind} ${extraClass}`.trim()}>
      {child}
      {/* Per-chunk footnotes (kept for backward compat if present) */}
      <PerChunkCites citations={chunk.citations} />
    </div>
  );

  if (kind === "heading") {
    const base = stripInternalCites(text || title);
    if (!base) return null;
    return wrap(<h3 dangerouslySetInnerHTML={{ __html: mdToHtml(base) }} />);
  }

  if (kind === "paragraph") {
    if (!text) return null;
    const base = stripInternalCites(text);
    return wrap(<p dangerouslySetInnerHTML={{ __html: mdToHtml(base) }} />);
  }

  if (kind === "callout" || kind === "note") {
    const sev = String(chunk.severity || "info").toLowerCase();
    const sevClass = SEVERITY_CLASS[sev] || "info";
    const t = title ? stripInternalCites(title) : "";
    const body = text ? stripInternalCites(text) : "";
    return wrap(
      <div className={`vc-structured-callout ${sevClass}`}>
        {t ? <strong>{t}</strong> : null}
        {body ? <p dangerouslySetInnerHTML={{ __html: mdToHtml(body) }} /> : null}
      </div>
    );
  }

  if (kind === "bullet_list" || kind === "numbered_list") {
    if (items.length === 0 && !title) return null;
    const ListTag = kind === "bullet_list" ? "ul" : "ol";
    const t = title ? stripInternalCites(title) : "";
    return wrap(
      <div>
        {t ? <div className="vc-structured-title">{t}</div> : null}
        {items.length ? (
          <ListTag>
            {items.map((item, i) => {
              const base = stripInternalCites(String(item));
              return (
                <li
                  key={`${index}-item-${i}`}
                  dangerouslySetInnerHTML={{ __html: mdToHtml(base) }}
                />
              );
            })}
          </ListTag>
        ) : null}
      </div>
    );
  }

  if (kind === "table" && table) {
    const columns = Array.isArray(table.columns) ? table.columns : [];
    const rows = Array.isArray(table.rows) ? table.rows : [];
    const t = title ? stripInternalCites(title) : "";
    return wrap(
      <div className="vc-structured-table">
        {t ? <div className="vc-structured-title">{t}</div> : null}
        <table>
          {columns.length ? (
            <thead>
              <tr>
                {columns.map((col, i) => (
                  <th key={`${index}-col-${i}`}>{escapeHtml(String(col))}</th>
                ))}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {rows.map((row, rIndex) => {
              // ✅ Handle both shapes:
              // - old: string[]
              // - new: { cells: string[] }
              const cells = Array.isArray(row)
                ? row
                : Array.isArray(row?.cells)
                ? row.cells
                : [];
              return (
                <tr key={`${index}-row-${rIndex}`}>
                  {cells.map((cell, cIndex) => (
                    <td key={`${index}-row-${rIndex}-cell-${cIndex}`}>
                      {escapeHtml(String(cell ?? ""))}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        {table.caption ? (
          <div className="vc-structured-caption">{escapeHtml(String(table.caption))}</div>
        ) : null}
      </div>
    );
  }

  const base = stripInternalCites(text || "");
  return wrap(base ? <p dangerouslySetInnerHTML={{ __html: mdToHtml(base) }} /> : null);
}

/* A single renderer for structured content + optional summary + global citations */
function StructuredRenderer({ chunks = [], summary, citations }) {
  const clean = Array.isArray(chunks) ? chunks.filter((c) => c && typeof c === "object") : [];
  const hasSummary = summary && String(summary).trim().length > 0;
  const hasCitations = Array.isArray(citations) && citations.length > 0;

  if (!clean.length && !hasSummary && !hasCitations) return null;

  return (
    <div className="vc-structured">
      {clean.map((chunk, index) => (
        <StructuredBlock chunk={chunk} index={index} key={`structured-${index}`} />
      ))}

      {hasSummary ? (
        <div className="vc-structured-summary">
          <strong>Resumen:</strong>
          <p
            dangerouslySetInnerHTML={{ __html: mdToHtml(stripInternalCites(String(summary))) }}
          />
        </div>
      ) : null}

      {hasCitations ? <GlobalCites citations={citations} /> : null}
    </div>
  );
}

/* ───────────────────── Plain text fallback (rare) ───────────────────── */
function applyCitationsToText(rawText, citations = []) {
  // We are NOT injecting links inline anymore — keep as-is.
  return rawText ?? "";
}

/* ───────────────────── Component ───────────────────── */
export default function VetChatTester() {
  const { apiBase, authFetch } = useAuth();
  const [consultationId, setConsultationId] = useState("demo-887scv");
  const [conversationKey, setConversationKey] = useState(null);
  const [messages, setMessages] = useState([]);
  const [connectionStatus, setConnectionStatus] = useState("idle");
  const [turnPhase, setTurnPhase] = useState(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);

  const inputRef = useRef(null);
  const endRef = useRef(null);
  const esRef = useRef(null);
  const retryTimer = useRef(null);
  const firstConnect = useRef(false);
  const reconnectingRef = useRef(false);

  useEffect(() => {
    try {
      inputRef.current?.focus();
    } catch {}
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const now = (d = new Date()) =>
    new Date(d).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  function toDisplayTs(tsLike) {
    try {
      return now(new Date(tsLike));
    } catch {
      return now();
    }
  }

  // Map persisted history → UI (includes structured chunks, summary, and citations if present)
  function mapHistoryMsgToUI(m) {
    const type = m.role === "user" ? "sent" : "received";
    const createdAt = m.created_at ? new Date(m.created_at) : new Date();

    const structuredChunks = Array.isArray(m.structured_chunks)
      ? m.structured_chunks
      : Array.isArray(m.structuredChunks)
      ? m.structuredChunks
      : [];
    const structuredSummary =
      m.structured_summary ?? m.summary ?? m.structuredSummary ?? null;
    const structuredCitations =
      m.structured_citations ?? m.structuredCitations ?? null;

    return {
      type,
      text: stripInternalCites(m.content || ""),
      isStreaming: false,
      lastChunk: "",
      timestamp: toDisplayTs(createdAt),
      createdAt,
      structuredChunks,
      structuredSummary,
      structuredCitations,
    };
  }

  async function fetchFullHistory(id) {
    if (!id) return;
    setLoadingHistory(true);
    try {
      const url = `${apiBase}/api/v1/vet_chat/${encodeURIComponent(id)}/history?limit=1000&order=asc`;
      const res = await authFetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const mapped = (data?.messages || []).map(mapHistoryMsgToUI);
      setMessages(mapped);
    } catch (err) {
      addError(`Failed to load history: ${err.message}`);
      setMessages([]);
    } finally {
      setLoadingHistory(false);
    }
  }

  function getLastPersistedCreatedAt() {
    const persisted = messages.filter((m) => !!m.createdAt && m.isStreaming === false);
    if (persisted.length === 0) return null;
    return new Date(Math.max(...persisted.map((m) => m.createdAt.getTime())));
  }

  async function fetchHistoryAfter(id, afterDate) {
    if (!id || !afterDate) return;
    try {
      const q = new URLSearchParams({
        limit: String(500),
        order: "asc",
        after: afterDate.toISOString(),
      });
      const url = `${apiBase}/api/v1/vet_chat/${encodeURIComponent(id)}/history?${q.toString()}`;
      const res = await authFetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const incoming = (data?.messages || []).map(mapHistoryMsgToUI);
      if (incoming.length === 0) return;

      setMessages((prev) => {
        const key = (m) => `${m.type}|${m.createdAt?.toISOString?.() || ""}|${m.text}`;
        const existing = new Set(prev.map(key));
        const dedup = incoming.filter((m) => !existing.has(key(m)));
        return [...prev, ...dedup];
      });
    } catch (err) {
      addError(`Failed to resync history: ${err.message}`);
    }
  }

  // ---------------- SSE connect ----------------
  useEffect(() => {
    if (!consultationId) return;

    const key = `vet_chat:${consultationId}`;
    setConversationKey(key);
    setMessages([]);
    setTurnPhase(null);
    setIsCancelling(false);
    firstConnect.current = false;

    let stopped = false;
    let attempt = 0;

    fetchFullHistory(consultationId);

    const url = `${RELAY_BASE}/vet-chat-stream/${encodeURIComponent(
      consultationId
    )}?v=${Date.now()}`;

    const connect = () => {
      if (stopped) return;

      const reconnecting = attempt > 0;
      reconnectingRef.current = reconnecting;
      setConnectionStatus(attempt === 0 ? "connecting" : "reconnecting");

      try {
        esRef.current?.close();
      } catch {}

      const es = new EventSource(url);
      esRef.current = es;

      es.onopen = async () => {
        const wasReconnecting = attempt > 0;
        attempt = 0;
        setConnectionStatus("connected");

        if (!firstConnect.current) {
          addLog(`Connected to ${key}`);
          firstConnect.current = true;
        } else if (wasReconnecting) {
          const last = getLastPersistedCreatedAt();
          if (last) await fetchHistoryAfter(consultationId, last);
          else await fetchFullHistory(consultationId);
        }
      };

      // default message = plain text chunk (used only if not structured)
      es.onmessage = (e) => handleIncomingChunk(e.data);

      // Structured chunks, summary, and top-level citations
      es.addEventListener("structured", (e) => {
        try {
          const payload = JSON.parse(e.data || "{}");
          const data = payload && payload.data ? payload.data : payload;
          addStructuredChunk(data);
        } catch {}
      });

      es.addEventListener("status", (e) => {
        try {
          const payload = JSON.parse(e.data || "{}");
          const phase = payload && payload.phase;

          if (phase === "started" || phase === "accepted" || phase === "thinking") {
            setTurnPhase("thinking");
            ensureAssistantStreamingBubble();
          }

          if (phase === "cancel_requested") {
            setIsCancelling(true);
            setTurnPhase("canceling");
            addLog("Cancel requested…");
          }

          if (phase === "cancelled") {
            setIsCancelling(false);
            setTurnPhase(null);
            handleIncomingChunk("[END-OF-STREAM]");
            addLog("Turn cancelled.");
          }

          if (phase === "completed" || phase === "done" || phase === "error") {
            setTurnPhase(null);
            setIsCancelling(false);
            handleIncomingChunk("[END-OF-STREAM]");
          }
        } catch {}
      });

      es.addEventListener("done", () => {
        setTurnPhase(null);
        setIsCancelling(false);
        handleIncomingChunk("[END-OF-STREAM]");
      });

      es.addEventListener("error", (e) => {
        setTurnPhase(null);
        setIsCancelling(false);
        try {
          const payload = JSON.parse(e.data || "{}");
          addError(payload?.message ? `Stream error: ${payload.message}` : "Stream error.");
        } catch {
          addError("Stream error.");
        }
        handleIncomingChunk("[END-OF-STREAM]");
      });

      es.onerror = () => {
        setConnectionStatus("reconnecting");
        try {
          es.close();
        } catch {}
        attempt += 1;
        const delay = Math.min(1000 * Math.pow(2, attempt), 15000);
        clearTimeout(retryTimer.current);
        retryTimer.current = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      stopped = true;
      try {
        esRef.current?.close();
      } catch {}
      clearTimeout(retryTimer.current);
      setConnectionStatus("idle");
    };
  }, [consultationId, apiBase]);

  function ensureAssistantStreamingBubble() {
    setMessages((prev) => {
      if (prev && prev.length) {
        for (let j = prev.length - 1; j >= 0; j--) {
          const m = prev[j];
          if (m.type === "received" && m.isStreaming) return prev;
        }
      }
      const createdAt = new Date();
      return [
        ...(prev || []),
        {
          type: "received",
          text: "",
          isStreaming: true,
          lastChunk: "",
          timestamp: toDisplayTs(createdAt),
          createdAt,
          animTick: Date.now(),
          structuredChunks: [],
          structuredSummary: null,
          structuredCitations: null,
        },
      ];
    });
  }

  /* -------------- Send message -------------- */
  async function sendMessage() {
    const text = (inputRef.current?.value || "").trim();
    if (!text || !consultationId) return;

    try {
      setTurnPhase("sending");

      const res = await authFetch(
        `${apiBase}/api/v1/vet_chat/${encodeURIComponent(consultationId)}/message`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", accept: "application/json" },
          body: JSON.stringify({ message: text }),
        }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const createdAt = new Date();
      setMessages((prev) => [
        ...prev,
        {
          type: "sent",
          text,
          isStreaming: false,
          timestamp: toDisplayTs(createdAt),
          createdAt,
        },
      ]);
      inputRef.current.value = "";
    } catch (err) {
      setTurnPhase(null);
      addError(`Failed to send: ${err.message}`);
    }
  }

  /* -------------- Cancel current turn -------------- */
  const canCancel =
    (messages.some((m) => m.type === "received" && m.isStreaming) ||
      turnPhase === "thinking" ||
      turnPhase === "sending") &&
    connectionStatus === "connected" &&
    !!consultationId;

  async function cancelTurn() {
    if (!canCancel || isCancelling) return;
    try {
      setIsCancelling(true);
      setTurnPhase("canceling");

      const res = await authFetch(
        `${apiBase}/api/v1/vet_chat/${encodeURIComponent(consultationId)}/cancel`,
        {
          method: "POST",
          headers: { accept: "application/json" },
        }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      addLog("Cancel requested…");
    } catch (err) {
      setIsCancelling(false);
      setTurnPhase(null);
      addError(`Failed to cancel: ${err.message}`);
    }
  }

  /* -------------- Streaming handlers -------------- */
  function addStructuredChunk(payload) {
    if (!payload || typeof payload !== "object") return;
    const { index, chunk, summary, citations } = payload;
    const hasIndex = typeof index === "number" && Number.isFinite(index);
    const hasChunk = chunk && typeof chunk === "object";
    const hasSummary = Object.prototype.hasOwnProperty.call(payload, "summary");
    const hasCitations = Object.prototype.hasOwnProperty.call(payload, "citations");
    if (!hasIndex && !hasSummary && !hasCitations) return;

    setMessages((prev) => {
      const next = prev ? prev.slice() : [];
      // Find last assistant bubble, prefer a streaming one
      let targetIdx = -1;
      for (let j = next.length - 1; j >= 0; j--) {
        const msg = next[j];
        if (msg.type === "received") {
          targetIdx = j;
          if (msg.isStreaming) break;
        }
      }
      if (targetIdx < 0) {
        const createdAt = new Date();
        next.push({
          type: "received",
          text: "",
          isStreaming: true,
          lastChunk: "",
          timestamp: toDisplayTs(createdAt),
          createdAt,
          animTick: Date.now(),
          structuredChunks: [],
          structuredSummary: null,
          structuredCitations: null,
        });
        targetIdx = next.length - 1;
      }

      const target = { ...next[targetIdx] };
      let mutated = false;

      if (hasSummary) {
        target.structuredSummary = summary ?? null;
        mutated = true;
      }

      if (hasCitations) {
        target.structuredCitations = Array.isArray(citations) ? citations : [];
        mutated = true;
      }

      if (hasIndex && hasChunk) {
        const arr = Array.isArray(target.structuredChunks)
          ? target.structuredChunks.slice()
          : [];
        arr[index] = chunk;
        target.structuredChunks = arr;
        mutated = true;
      }

      if (!mutated) return prev;

      target.animTick = Date.now();
      next[targetIdx] = target;
      return next;
    });
  }

  function handleIncomingChunk(raw) {
    const chunk = stripInternalCites(raw ?? "");
    const sentinel = "[END-OF-STREAM]";

    if (chunk.trim() === sentinel) {
      setMessages((prev) => {
        for (let j = prev.length - 1; j >= 0; j--) {
          const m = prev[j];
          if (m.type === "received" && m.isStreaming) {
            const copy = prev.slice();
            copy[j] = { ...m, isStreaming: false, lastChunk: "" };
            return copy;
          }
        }
        return prev;
      });
      return;
    }

    if (!chunk) return;
    setTurnPhase(null);

    setMessages((prev) => {
      for (let j = prev.length - 1; j >= 0; j--) {
        const m = prev[j];
        const hasStructured =
          Array.isArray(m.structuredChunks) &&
          m.structuredChunks.some((c) => c && typeof c === "object");

        if (m.type === "received" && m.isStreaming && !hasStructured) {
          const copy = prev.slice();
          copy[j] = {
            ...m,
            text: (m.text || "") + chunk,
            lastChunk: chunk,
            animTick: Date.now(),
          };
          return copy;
        }
        if (m.type === "received") break;
      }

      const createdAt = new Date();
      return [
        ...prev,
        {
          type: "received",
          text: chunk,
          isStreaming: true,
          lastChunk: chunk,
          timestamp: toDisplayTs(createdAt),
          createdAt,
          animTick: Date.now(),
          structuredChunks: [],
          structuredSummary: null,
          structuredCitations: null,
        },
      ];
    });
  }

  /* -------------- Helpers & rendering -------------- */
  const addLog = (text) =>
    setMessages((p) => [
      ...p,
      { type: "system", text, isStreaming: false, timestamp: now(), createdAt: new Date() },
    ]);
  const addError = (text) =>
    setMessages((p) => [
      ...p,
      { type: "error", text, isStreaming: false, timestamp: now(), createdAt: new Date() },
    ]);

  const isStreaming =
    messages.length > 0 && messages.some((m) => m.type === "received" && m.isStreaming);

  const connectionLabel = useMemo(() => {
    if (connectionStatus !== "connected") {
      return connectionStatus.charAt(0).toUpperCase() + connectionStatus.slice(1);
    }
    if (isCancelling || turnPhase === "canceling") return "Canceling…";
    if (isStreaming) return "Streaming…";
    if (turnPhase === "thinking") return "Thinking…";
    if (turnPhase === "sending") return "Sending…";
    if (loadingHistory) return "Loading history…";
    return "Connected";
  }, [connectionStatus, isStreaming, turnPhase, loadingHistory, isCancelling]);

  function renderMessage(msg, i) {
    if (msg.type === "system" || msg.type === "error") {
      return (
        <div key={i} className="vc-system">
          <span className={`vc-system-pill ${msg.type}`}>{msg.text}</span>
        </div>
      );
    }

    const container = `vc-row ${msg.type}`;
    const bubble = `vc-bubble ${msg.type} ${msg.isStreaming ? "streaming" : ""}`;

    const hasStructured = Array.isArray(msg.structuredChunks)
      ? msg.structuredChunks.some((chunk) => chunk && typeof chunk === "object")
      : false;

    let tailCandidate = "";
    let shouldShowTail = false;
    let html = "";

    if (!hasStructured) {
      const full = msg.text || "";
      tailCandidate = msg.isStreaming ? msg.lastChunk || "" : "";
      shouldShowTail = !!tailCandidate && full.endsWith(tailCandidate);
      const stable = shouldShowTail ? full.slice(0, full.length - tailCandidate.length) : full;
      const withCites = applyCitationsToText(stable); // no inline cites in plain mode
      html = mdToHtml(stripInternalCites(withCites));
    }

    return (
      <div key={i} className={container}>
        <div className={`vc-avatar ${msg.type}`} aria-hidden="true">
          {msg.type === "sent" ? "U" : "A"}
        </div>
        <div className={bubble}>
          <div className="vc-text">
            {hasStructured ? (
              <StructuredRenderer
                chunks={msg.structuredChunks}
                summary={msg.structuredSummary}
                citations={msg.structuredCitations}
              />
            ) : (
              <>
                <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
                {shouldShowTail && (
                  <span key={msg.animTick} className="chunk-fade">
                    {escapeHtml(tailCandidate)}
                  </span>
                )}
              </>
            )}
          </div>
          <div className="vc-meta">
            <span className="vc-ts">{msg.timestamp}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="vc-root">
      <div className="vc-auth">
        <LoginBox title="Vet Chat Auth" />
      </div>
      {/* Header */}
      <header className="vc-header">
        <div className="vc-brand">
          <h1>Vet-Chat Tester</h1>
        </div>

        <div className="vc-controls">
          <div className="field">
            <label htmlFor="cid">Consultation ID</label>
            <input
              id="cid"
              value={consultationId}
              onChange={(e) => setConsultationId(e.target.value)}
              placeholder="demo-123"
            />
          </div>
          <button
            className="vc-reload"
            onClick={() => fetchFullHistory(consultationId)}
            title="Reload history"
            style={{ marginLeft: 8 }}
          >
            Reload
          </button>
          <div className="vc-conn">
            <span className={`vc-dot ${connectionStatus}`} />
            <span className="vc-conn-label">{connectionLabel}</span>
          </div>
          <button
            className={`vc-cancel ${canCancel ? "" : "disabled"}`}
            onClick={cancelTurn}
            disabled={!canCancel || isCancelling}
            title="Cancel current turn"
            style={{ marginLeft: 8 }}
          >
            {isCancelling ? "Canceling…" : "Cancel"}
          </button>
        </div>
      </header>

      {/* Small info line */}
      <div className="vc-sub">
        {conversationKey ? `Connected to ${conversationKey}` : "Not connected"}
      </div>

      {/* Messages */}
      <main className="vc-list" aria-live="polite">
        {messages.length === 0 ? (
          <div className="vc-empty">
            <div className="vc-empty-emoji" aria-hidden="true">
              💬
            </div>
            <h3>{loadingHistory ? "Loading history…" : "Start a conversation"}</h3>
            <p>{loadingHistory ? "Please wait." : "Type a message to begin."}</p>
          </div>
        ) : (
          messages.map((m, i) => renderMessage(m, i))
        )}
        <div ref={endRef} />
      </main>

      {/* Input */}
      <footer className="vc-input">
        <input
          ref={inputRef}
          type="text"
          placeholder="Type a message…"
          onKeyDown={(e) => e.key === "Enter" && sendMessage()}
        />
        <div className="vc-actions">
          <button
            className={`vc-cancel ${canCancel ? "" : "disabled"}`}
            onClick={cancelTurn}
            disabled={!canCancel || isCancelling}
            title="Cancel streaming"
            aria-label="Cancel streaming"
          >
            {isCancelling ? "Canceling…" : "Cancel"}
          </button>
          <button className="vc-send" onClick={sendMessage} title="Send" aria-label="Send message">
            ➤
          </button>
        </div>
      </footer>
    </div>
  );
}
