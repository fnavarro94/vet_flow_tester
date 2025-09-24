import React, { Suspense, useEffect, useState } from "react";
import "./App.css";

// Lazy-load testers
const VetChatTester    = React.lazy(() => import("./testers/VetChatTester"));
const VetWorkflowApp   = React.lazy(() => import("./testers/VetWorkflowApp"));

const TABS = [
  { key: "chat",     label: "Vet Chat" },
  { key: "workflow", label: "Vet Workflow" },
];

export default function App() {
  const [tab, setTab] = useState(() => {
    const qs = new URLSearchParams(window.location.search);
    return qs.get("tab") || localStorage.getItem("tester_tab") || "chat";
  });

  useEffect(() => {
    try {
      localStorage.setItem("tester_tab", tab);
      const url = new URL(window.location.href);
      url.searchParams.set("tab", tab);
      window.history.replaceState({}, "", url);
    } catch {}
  }, [tab]);

  return (
    <div className="app-root">
      {/* Sticky top tabs */}
      <div className="top-tabs">
        <strong style={{ marginRight: 8 }}>Testers</strong>
        <div className="segmented" role="tablist" aria-label="Tester tabs">
     
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={`seg-btn ${tab === t.key ? "active" : ""}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Body slot: the tester fills this area */}
      <div className="body-slot" aria-live="polite">
        <Suspense fallback={<div style={{ padding: 16 }}>Loading…</div>}>
          {tab === "chat" ? <VetChatTester /> : <VetWorkflowApp />}
        </Suspense>
      </div>
    </div>
  );
}
