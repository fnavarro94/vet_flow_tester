import React, { useEffect, useMemo, useRef, useState, useContext, useCallback } from "react";
import { RELAY_BASE } from "../config";
import { useAuth } from "../auth/AuthContext.jsx";
import LoginBox from "../components/LoginBox.jsx";

/* ─────────────────────────── Helpers ────────────────────────── */
const KINDS = {
  diagnostics:              { label: "Diagnostics",               path: "diagnostics" },
  additional_exams:         { label: "Additional exams",          path: "additional_exams" },
  prescription:             { label: "Prescription",              path: "prescription" },
  complementary_treatments: { label: "Complementary treatments",  path: "complementary_treatments" },
};

const now = () =>
  new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const phaseMatchesKind = (phase = "", kindKey) => {
  if (!phase || !kindKey) return false;
  const p = String(phase).replace(/-/g, "_"); // tolerant, but underscore is canonical
  const k = String(kindKey);
  return p.startsWith(k);
};

const isBusyStatus = (s) =>
  ["queued", "running", "cancel_requested"].includes(String(s || "").toLowerCase());
const canCancelFrom = (s) =>
  ["queued", "running"].includes(String(s || "").toLowerCase());
const fmtTS = (ts) => {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
};

/* Priority helpers (only used in the Workflow tab for "additional_exams") */
const PRIORITY_ORDER = { alta: 0, media: 1, baja: 2 };

function PriorityBadge({ priority }) {
  if (!priority) return null;
  const label = String(priority).toLowerCase();
  return (
    <span className="badge" title={`Prioridad: ${label}`}>
      {label}
    </span>
  );
}

/* ─────────────────────────── SSE Context (for Workflow tab only) ─────────────────────────── */
const SSEContext = React.createContext(null);

function SSEProvider({ sessionId, children }) {
  const { apiBase, authFetch } = useAuth();
  const esRef = useRef(null);
  const retryTimerRef = useRef(null);
  const attemptRef = useRef(0);
  const openPromiseRef = useRef(null);

  const [status, setStatus] = useState("idle"); // idle | connecting | connected | reconnecting
  const listenersRef = useRef(new Map());

  const addListener = useCallback((evt, cb) => {
    let set = listenersRef.current.get(evt);
    if (!set) {
      set = new Set();
      listenersRef.current.set(evt, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  }, []);
  const emit = useCallback((evt, data, raw) => {
    const set = listenersRef.current.get(evt);
    if (set) for (const cb of Array.from(set)) { try { cb(data, raw); } catch {} }
  }, []);

  const tearDown = useCallback(() => {
    clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    try {
      esRef.current?.close();
    } catch {}
    esRef.current = null;
  }, []);

  const rehydrateFromState = useCallback(
    async (sid) => {
      if (!sid) return;
      try {
        const res = await authFetch(`${apiBase}/api/v1/vet/${encodeURIComponent(sid)}/state`, {
          headers: { accept: "application/json" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        // Server already uses underscore keys; keep as-is
        const runs = data.runs || {};
        const outputs_updated_at = data.outputs_updated_at || {};
        emit("rehydrate", { runs, outputs_updated_at });
      } catch (e) {
        emit("rehydrate-error", { message: e?.message || "rehydrate failed" });
      }
    },
    [emit, apiBase, authFetch]
  );

  const ensureConnected = useCallback(() => {
    if (!sessionId) return Promise.resolve();
    if (esRef.current && esRef.current.readyState === 1) return Promise.resolve();
    if (openPromiseRef.current?.promise) return openPromiseRef.current.promise;

    setStatus("connecting");
    const url = `${RELAY_BASE}/vet-stream/${encodeURIComponent(sessionId)}?v=${Date.now()}`;

    let resolveOuter;
    const promise = new Promise((res) => (resolveOuter = res));
    openPromiseRef.current = { promise, resolve: resolveOuter };

    const start = () => {
      try {
        esRef.current?.close();
      } catch {}
      const es = new EventSource(url);
      esRef.current = es;

      const parse = (d) => {
        try {
          return JSON.parse(d || "{}");
        } catch {
          return {};
        }
      };

      es.onopen = async () => {
        attemptRef.current = 0;
        setStatus("connected");
        await rehydrateFromState(sessionId); // persisted state fetch
        if (openPromiseRef.current?.resolve) {
          openPromiseRef.current.resolve();
          openPromiseRef.current = null;
        }
      };

      es.onmessage = (e) => emit("message", e?.data, e);
      es.addEventListener("ready", (e) => emit("ready", {}, e));
      es.addEventListener("status", (e) => emit("status", parse(e.data), e));
      es.addEventListener("done", (e) => emit("done", parse(e.data), e));
      es.addEventListener("error", (e) => emit("error", parse(e.data), e));

      // Workflow payloads (underscore event names)
      es.addEventListener("diagnostics", (e) => emit("diagnostics", parse(e.data), e));
      es.addEventListener("additional_exams", (e) => emit("additional_exams", parse(e.data), e));
      es.addEventListener("prescription", (e) => emit("prescription", parse(e.data), e));
      es.addEventListener("complementary_treatments", (e) =>
        emit("complementary_treatments", parse(e.data), e)
      );

      es.onerror = () => {
        setStatus("reconnecting");
        try {
          es.close();
        } catch {}
        attemptRef.current += 1;
        const delay = Math.min(1000 * Math.pow(2, attemptRef.current), 15000);
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = setTimeout(start, delay);
      };
    };

    start();
    return promise;
  }, [emit, sessionId, rehydrateFromState]);

  useEffect(() => {
    if (!sessionId) return;
    tearDown();
    attemptRef.current = 0;
    openPromiseRef.current = null;
    ensureConnected();
  }, [sessionId, ensureConnected, tearDown]);

  useEffect(() => () => tearDown(), [tearDown]);

  const value = { status, ensureConnected, addListener, rehydrateFromState };
  return <SSEContext.Provider value={value}>{children}</SSEContext.Provider>;
}

function useSSE() {
  const ctx = useContext(SSEContext);
  if (!ctx) throw new Error("useSSE must be used inside <SSEProvider>");
  return ctx;
}

/* ─────────────────────────── Workflow Panel (SSE-driven) ─────────────────────────── */
function WorkflowPanel({ kindKey, sessionId }) {
  const meta = KINDS[kindKey];
  const { apiBase, authFetch } = useAuth();
  const { status: connStatus, ensureConnected, addListener } = useSSE();

  const [logs, setLogs] = useState([]);
  const [lastPayload, setLastPayload] = useState(null);
  const [runState, setRunState] = useState({ status: "idle", phase: null, error_message: null });

  const log = (text) => setLogs((prev) => [...prev, { ts: now(), text }]);

  useEffect(() => {
    const offRehydrate = addListener("rehydrate", (full) => {
      try {
        const s = (full?.runs && full.runs[kindKey]) || { status: "idle" };
        const statusLower = String(s.status || "idle").toLowerCase();
        setRunState({
          status: statusLower,
          phase: s.phase || null,
          error_message: s.error_message || null,
        });
        log(`rehydrate ▸ ${statusLower.replaceAll("_", " ")}`);
      } catch {}
    });
    const offRehydrateErr = addListener("rehydrate-error", (e) => {
      log(`rehydrate ❌ ${e?.message || "failed"}`);
    });

    const offStatus = addListener("status", (payload) => {
      const phRaw = payload?.phase || "";
      const ph = phRaw.replace(/-/g, "_"); // normalize just in case
      if (phaseMatchesKind(ph, kindKey)) {
        log(`status ▸ ${ph}`);
        if (ph.endsWith("_started")) setRunState((r) => ({ ...r, status: "running", phase: ph }));
        else if (ph.endsWith("_cancel_requested"))
          setRunState((r) => ({ ...r, status: "cancel_requested", phase: ph }));
        else if (ph.endsWith("_finished")) setRunState((r) => ({ ...r, phase: ph }));
        else if (ph.endsWith("_cancelled")) setRunState((r) => ({ ...r, status: "cancelled", phase: ph }));
      }
    });

    const offKind = addListener(kindKey, (data) => {
      setLastPayload(data);
      log(`${kindKey} ▶ payload received`);
    });

    const offDone = addListener("done", (payload) => {
      const payloadKind = String(payload?.kind || "").replace(/-/g, "_");
      if (!payload?.kind || payloadKind === kindKey) {
        log(`done ▸ ${payloadKind || kindKey}`);
        setRunState((r) => ({ ...r, status: "done" }));
      }
    });

    const offErr = addListener("error", (payload) => {
      const msg = payload?.message || "unknown";
      log(`error ▸ ${msg}`);
      setRunState((r) => ({ ...r, status: "error", error_message: msg }));
    });

    return () => {
      offRehydrate();
      offRehydrateErr();
      offStatus();
      offKind();
      offDone();
      offErr();
    };
  }, [addListener, kindKey]);

  const queue = async () => {
    if (!sessionId) {
      log("⚠️ Enter a session id first");
      return;
    }
    try {
      setLastPayload(null);
      setRunState({ status: "queued", phase: `${meta.path}_queued`, error_message: null });
      log(`queueing… (${meta.label})`);
      await ensureConnected();
      const res = await authFetch(
        `${apiBase}/api/v1/vet/${encodeURIComponent(sessionId)}/${meta.path}/queue`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", accept: "application/json" },
        }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      log(`queued ✓ task_id=${data.task_id}`);
    } catch (err) {
      log(`❌ queue failed: ${err.message}`);
      setRunState({ status: "idle", phase: null, error_message: err.message });
    }
  };

  const cancel = async () => {
    if (!sessionId) {
      log("⚠️ Enter a session id first");
      return;
    }
    try {
      setRunState((r) => ({
        ...r,
        status: "cancel_requested",
        phase: `${meta.path}_cancel_requested`,
        error_message: null,
      }));
      log(`cancel → ${meta.label} (requesting)`);
      await ensureConnected();

      const res = await authFetch(
        `${apiBase}/api/v1/vet/${encodeURIComponent(sessionId)}/${meta.path}/cancel`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", accept: "application/json" },
        }
      );

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      log(`cancel requested ✓ kind=${data.kind || meta.path}`);
    } catch (err) {
      log(`❌ cancel failed: ${err.message}`);
      setRunState((r) => ({ ...r, status: "running", error_message: err.message }));
    }
  };

  const busy = isBusyStatus(runState.status);
  const connectionLabel = useMemo(() => {
    if (connStatus === "connecting") return "Connecting…";
    if (connStatus === "reconnecting") return "Reconnecting…";
    if (busy) return "Streaming…";
    if (connStatus === "connected") return "Connected";
    return "Idle";
  }, [connStatus, busy]);

  return (
    <div
      className="card"
      style={{ display: "grid", gap: 8, height: "100%", gridTemplateRows: "auto auto 1fr auto" }}
    >
      <div
        className="card-title"
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
      >
        <span>{meta.label}</span>
        <span className="pill">{connectionLabel}</span>
      </div>

      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: 10,
          background: "var(--surface)",
          minHeight: 52,
          maxHeight: 180,
          overflowY: "auto",
        }}
      >
        {lastPayload?.items?.length ? (
          <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {lastPayload.items.map((it, i) => {
              const isDx = "probability" in it;
              const isMed = "active_principle" in it || "dose" in it || "presentation" in it;
              const isAE =
                kindKey === "additional_exams" || "indications" in it || "priority" in it;
              const isCT = !isDx && !isMed && !isAE;
              return (
                <li key={i} style={{ marginBottom: 10 }}>
                  <div
                    style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}
                  >
                    <strong>{it.name || `Item ${i + 1}`}</strong>
                    {isDx && typeof it.probability === "number" && (
                      <span className="badge">{Math.round(it.probability * 100)}%</span>
                    )}
                    {isAE && it.priority && <PriorityBadge priority={it.priority} />}
                  </div>
                  {isDx && it.rationale && <div style={{ opacity: 0.85 }}>{it.rationale}</div>}
                  {isAE && (
                    <div style={{ opacity: 0.95 }}>
                      <div>
                        <em>Posibles indicaciones:</em> {it.indications || it.notes || "—"}
                      </div>
                    </div>
                  )}
                  {isMed && (
                    <div style={{ opacity: 0.95 }}>
                      <div>
                        <em>Principio activo:</em> {it.active_principle || "—"}
                      </div>
                      <div>
                        <em>Dosis:</em> {it.dose ?? "—"} {it.dose_unit || ""}{" "}
                        {" · "}
                        <em>Presentación:</em> {it.presentation || "—"}
                      </div>
                      <div>
                        <em>Frecuencia:</em> {it.frequency || "—"} {" · "}
                        <em>Cantidad:</em> {it.quantity ?? "—"} {it.quantity_unit || ""}
                      </div>
                      {it.notes && (
                        <div>
                          <em>Indicaciones:</em> {it.notes}
                        </div>
                      )}
                    </div>
                  )}
                  {isCT && (
                    <div style={{ opacity: 0.95 }}>
                      {it.quantity && (
                        <div>
                          <em>Cantidad:</em> {it.quantity}
                        </div>
                      )}
                      {(it.notes || it.indications) && (
                        <div>
                          <em>Indicaciones:</em> {it.notes || it.indications}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <div style={{ color: "var(--muted)" }}>
            {busy ? "Processing… (awaiting live results)" : "No results yet."}
          </div>
        )}
      </div>

      <div
        style={{
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: 10,
          overflowY: "auto",
          whiteSpace: "pre-wrap",
          lineHeight: 1.3,
          minHeight: 0,
        }}
        aria-live="polite"
      >
        {logs.length === 0 ? (
          <div style={{ color: "var(--muted)" }}>No events yet.</div>
        ) : (
          logs.map((l, i) => (
            <div key={i}>
              <span style={{ opacity: 0.6 }}>{l.ts}</span> — {l.text}
            </div>
          ))
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <button className="button primary" onClick={queue} disabled={isBusyStatus(runState.status)}>
          {isBusyStatus(runState.status) ? "Running…" : `Queue ${meta.label}`}
        </button>
        <button
          className="button"
          onClick={cancel}
          disabled={!canCancelFrom(runState.status)}
          title={!canCancelFrom(runState.status) ? "Nothing to cancel" : "Cancel in-flight run"}
        >
          Cancel {meta.label}
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────────── NEW: State Explorer (persisted endpoints only) ─────────────────────────── */
function SessionStateExplorer({ sessionId }) {
  const { apiBase, authFetch } = useAuth();
  const [loading, setLoading] = useState(false);
  const [runs, setRuns] = useState(null);                         // underscore-keyed map
  const [outputsUpdatedAt, setOutputsUpdatedAt] = useState(null); // underscore-keyed map
  const [outputs, setOutputs] = useState({});                     // { kind: { updated_at, result } }
  const [logs, setLogs] = useState([]);
  const [autoRefresh, setAutoRefresh] = useState(false);

  const log = (t) => setLogs((p) => [...p, { ts: now(), t }]);

  const fetchState = useCallback(async () => {
    if (!sessionId) {
      setRuns(null);
      setOutputsUpdatedAt(null);
      return;
    }
    setLoading(true);
    try {
      const res = await authFetch(
        `${apiBase}/api/v1/vet/${encodeURIComponent(sessionId)}/state`,
        { headers: { accept: "application/json" } }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRuns(data.runs || {});
      setOutputsUpdatedAt(data.outputs_updated_at || {});
      log("state ✓ fetched");
    } catch (e) {
      log(`state ❌ ${e.message}`);
      setRuns(null);
      setOutputsUpdatedAt(null);
    } finally {
      setLoading(false);
    }
  }, [sessionId, apiBase, authFetch]);

  const fetchAllOutputs = useCallback(async () => {
    if (!sessionId) return;
    const entries = await Promise.all(
      Object.keys(KINDS).map(async (k) => {
        const kind = k; // underscore slug for the endpoint
        try {
          const resp = await authFetch(
            `${apiBase}/api/v1/vet/${encodeURIComponent(sessionId)}/outputs/${encodeURIComponent(kind)}`,
            { headers: { accept: "application/json" } }
          );
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const data = await resp.json();
          return [kind, { updated_at: data.updated_at || null, result: data.result || {} }];
        } catch (e) {
          return [kind, { updated_at: null, result: { _error: e.message } }];
        }
      })
    );
    const map = Object.fromEntries(entries);
    setOutputs(map);
    log("outputs ✓ fetched");
  }, [sessionId, apiBase, authFetch]);

  // Initial load + optional auto refresh
  useEffect(() => {
    fetchState();
    fetchAllOutputs();
  }, [fetchState, fetchAllOutputs]);
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      fetchState();
      fetchAllOutputs();
    }, 5000);
    return () => clearInterval(id);
  }, [autoRefresh, fetchState, fetchAllOutputs]);

  return (
    <div style={{ display: "grid", gap: 12, gridTemplateRows: "auto auto 1fr" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          className="button"
          onClick={() => {
            fetchState();
            fetchAllOutputs();
          }}
          disabled={loading}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          Auto-refresh (5s)
        </label>
        {sessionId ? (
          <span className="pill">Session: {sessionId}</span>
        ) : (
          <span className="pill">Enter a Session ID</span>
        )}
      </div>

      <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead style={{ background: "var(--surface)" }}>
            <tr>
              <th style={th}>Kind</th>
              <th style={th}>Status</th>
              <th style={th}>Phase</th>
              <th style={th}>Started</th>
              <th style={th}>Finished</th>
              <th style={th}>Updated</th>
              <th style={th}>Output updated_at</th>
            </tr>
          </thead>
          <tbody>
            {Object.keys(KINDS).map((k) => {
              const meta = KINDS[k];
              const s = runs?.[k] || {};
              const status = String(s.status || "idle").toLowerCase();
              const outAt = outputsUpdatedAt?.[k];
              return (
                <tr key={k} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={td}>
                    <strong>{meta.label}</strong>
                  </td>
                  <td style={td}>
                    <span className="pill">{status.replaceAll("_", " ")}</span>
                  </td>
                  <td style={td} title={s.phase || ""}>
                    {s.phase || "—"}
                  </td>
                  <td style={td}>{fmtTS(s.started_at)}</td>
                  <td style={td}>{fmtTS(s.finished_at)}</td>
                  <td style={td}>{fmtTS(s.updated_at)}</td>
                  <td style={td}>{fmtTS(outAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Persisted outputs (JSON) */}
      <div style={{ display: "grid", gap: 12 }}>
        {Object.keys(KINDS).map((k) => {
          const meta = KINDS[k];
          const out = outputs?.[k] || { updated_at: null, result: {} };
          const pretty = safePretty(out.result);
          return (
            <div key={k} className="card" style={{ padding: 12 }}>
              <div
                className="card-title"
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <strong>{meta.label} — persisted output</strong>
                  <span className="pill">updated_at: {fmtTS(out.updated_at)}</span>
                </div>
                <button className="button" onClick={() => copyText(pretty)} title="Copy JSON">
                  Copy JSON
                </button>
              </div>
              <pre style={preJSON} aria-label={`${meta.label} persisted JSON`}>
                {pretty}
              </pre>
            </div>
          );
        })}
      </div>

      <div
        style={{
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: 10,
          overflowY: "auto",
          whiteSpace: "pre-wrap",
          lineHeight: 1.3,
          minHeight: 0,
        }}
        aria-live="polite"
      >
        {logs.length === 0 ? (
          <div style={{ color: "var(--muted)" }}>No logs yet.</div>
        ) : (
          logs.map((l, i) => (
            <div key={i}>
              <span style={{ opacity: 0.6 }}>{l.ts}</span> — {l.t}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function safePretty(obj) {
  try {
    return JSON.stringify(obj ?? {}, null, 2);
  } catch {
    return String(obj);
  }
}
async function copyText(txt) {
  try {
    await navigator.clipboard.writeText(txt);
  } catch {}
}

const th = { textAlign: "left", padding: "10px 12px", borderBottom: "1px solid var(--border)" };
const td = { padding: "8px 12px", verticalAlign: "top" };
const preJSON = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: 12,
  margin: 0,
  overflowX: "auto",
  maxHeight: 260,
};

/* ─────────────────────────── Root with Tabs ───────────────────────────── */
export default function VetWorkflowApp() {
  const [sessionId, setSessionId] = useState("1");
  const [tab, setTab] = useState("explorer"); // default to Explorer so you verify persistence

  return (
    <SSEProvider sessionId={sessionId}>
      <div
        className="chat-root two-col"
        style={{ gridTemplateColumns: "1fr", background: "var(--bg)", padding: 12, height: "100vh" }}
      >
        <div
          className="session-pane"
          style={{
            border: "none",
            background: "transparent",
            display: "flex",
            flexDirection: "column",
            height: "100%",
          }}
        >
          <div style={{ marginBottom: 12, display: "flex" }}>
            <LoginBox title="Vet Workflow Auth" />
          </div>
          <div className="session-header" style={{ position: "static", background: "var(--surface)" }}>
            <div className="session-title" style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <h2 style={{ margin: 0 }}>Vet Workflow</h2>
              <GlobalStatusPill />
            </div>

            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
              <label style={{ fontSize: 12, opacity: 0.8 }}>Session ID</label>
              <input
                type="text"
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
                placeholder="e.g., sess-gi"
                style={{
                  border: "1px solid var(--border)",
                  background: "var(--surface)",
                  padding: ".4rem .6rem",
                  borderRadius: 8,
                  color: "var(--text)",
                }}
              />

              {/* Tabs */}
              <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                <button
                  className="button"
                  onClick={() => setTab("workflow")}
                  style={{
                    background: tab === "workflow" ? "var(--surface)" : "transparent",
                    border: "1px solid var(--border)",
                  }}
                >
                  Workflow (SSE)
                </button>
                <button
                  className="button"
                  onClick={() => setTab("explorer")}
                  style={{
                    background: tab === "explorer" ? "var(--surface)" : "transparent",
                    border: "1px solid var(--border)",
                  }}
                >
                  State Explorer (persisted)
                </button>
              </div>
            </div>
          </div>

          <div
            className="session-content"
            style={{ overflow: "hidden", flex: 1, display: "flex", flexDirection: "column" }}
          >
            {tab === "workflow" ? (
              <div
                className="cards"
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(4, minmax(260px, 1fr))",
                  gap: 12,
                  height: "100%",
                  alignItems: "stretch",
                }}
              >
                <WorkflowPanel kindKey="diagnostics"              sessionId={sessionId} />
                <WorkflowPanel kindKey="additional_exams"         sessionId={sessionId} />
                <WorkflowPanel kindKey="prescription"             sessionId={sessionId} />
                <WorkflowPanel kindKey="complementary_treatments" sessionId={sessionId} />
              </div>
            ) : (
              <div style={{ padding: 8, height: "100%", overflow: "auto" }}>
                <SessionStateExplorer sessionId={sessionId} />
              </div>
            )}
          </div>
        </div>
      </div>
    </SSEProvider>
  );
}

function GlobalStatusPill() {
  const { status } = useSSE();
  const label =
    status === "connecting"
      ? "Connecting…"
      : status === "reconnecting"
      ? "Reconnecting…"
      : status === "connected"
      ? "Connected"
      : "Idle";
  return (
    <span
      className="pill"
      style={{
        fontSize: 12,
        padding: "4px 8px",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 999,
      }}
    >
      {label}
    </span>
  );
}
