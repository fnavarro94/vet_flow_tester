import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AUTH_DEFAULTS, useAuth } from "../auth/AuthContext.jsx";

const HOST_OPTIONS = [
  { label: "Dev", value: "https://api-dev.bepetz.com" },
  { label: "Prod", value: "https://api.bepetz.com" },
];

export default function LoginBox({ title = "Auth" }) {
  const {
    apiHost,
    setApiHost,
    isLoggedIn,
    userEmail,
    signIn,
    confirmSignIn,
    signOut,
    pendingEmail,
    pendingSession,
    isWorking,
    error,
    message,
    resetStatus,
  } = useAuth();

  const [emailInput, setEmailInput] = useState(() => pendingEmail || userEmail || "");
  const [codeInput, setCodeInput] = useState("");
  const [hostInput, setHostInput] = useState(() => apiHost || AUTH_DEFAULTS.host);

  useEffect(() => {
    if (pendingEmail && pendingEmail !== emailInput) setEmailInput(pendingEmail);
  }, [pendingEmail]);

  useEffect(() => {
    if (userEmail && userEmail !== emailInput) setEmailInput(userEmail);
  }, [userEmail]);

  useEffect(() => {
    setHostInput(apiHost || AUTH_DEFAULTS.host);
  }, [apiHost]);

  const normalisedHost = useMemo(() => apiHost || AUTH_DEFAULTS.host, [apiHost]);
  const pendingLabel = pendingEmail && !isLoggedIn ? `Pending verification for ${pendingEmail}` : null;

  const commitHost = useCallback(
    (value) => {
      resetStatus();
      setApiHost(value);
    },
    [resetStatus, setApiHost]
  );

  const handleHostChange = (evt) => {
    setHostInput(evt.target.value);
  };

  const handleHostBlur = () => commitHost(hostInput);

  const handleHostKeyDown = (evt) => {
    if (evt.key === "Enter") {
      evt.preventDefault();
      commitHost(hostInput);
    }
  };

  const handleSignIn = async (evt) => {
    evt.preventDefault();
    resetStatus();
    try {
      await signIn(emailInput);
      setCodeInput("");
    } catch {}
  };

  const handleConfirm = async (evt) => {
    evt.preventDefault();
    resetStatus();
    try {
      await confirmSignIn(codeInput);
      setCodeInput("");
    } catch {}
  };

  return (
    <section className="login-box">
      <header className="login-box__header">
        <strong>{title}</strong>
        {isLoggedIn ? (
          <span className="login-box__status" aria-live="polite">
            Logged in as <mark>{userEmail}</mark>
          </span>
        ) : (
          <span className="login-box__status" aria-live="polite">
            {pendingLabel || "Not authenticated"}
          </span>
        )}
      </header>

      <form className="login-box__form" onSubmit={handleSignIn}>
        <div className="login-box__field">
          <label htmlFor="login-host">API Host</label>
          <div className="login-box__host-row">
            <input
              id="login-host"
              name="host"
              type="text"
              value={hostInput}
              onChange={handleHostChange}
              onBlur={handleHostBlur}
              onKeyDown={handleHostKeyDown}
              disabled={isWorking}
            />
            <div className="login-box__host-buttons" role="group" aria-label="Preset hosts">
              {HOST_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`host-btn ${normalisedHost === opt.value ? "active" : ""}`}
                  onClick={() => {
                    setHostInput(opt.value);
                    commitHost(opt.value);
                  }}
                  disabled={isWorking}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="login-box__field">
          <label htmlFor="login-email">Email</label>
          <div className="login-box__row">
            <input
              id="login-email"
              name="email"
              type="email"
              placeholder="vet@example.com"
              value={emailInput}
              onChange={(evt) => setEmailInput(evt.target.value)}
              disabled={isWorking}
              required
            />
            <button type="submit" disabled={isWorking || !emailInput.trim()}>
              Send Code
            </button>
          </div>
        </div>
      </form>

      <form className="login-box__form" onSubmit={handleConfirm}>
        <div className="login-box__field">
          <label htmlFor="login-code">Code</label>
          <div className="login-box__row">
            <input
              id="login-code"
              name="code"
              type="text"
              value={codeInput}
              placeholder="123456"
              onChange={(evt) => setCodeInput(evt.target.value)}
              disabled={isWorking || !pendingSession}
            />
            <button type="submit" disabled={isWorking || !pendingSession || !codeInput.trim()}>
              Confirm Login
            </button>
          </div>
        </div>
      </form>

      <div className="login-box__footer" aria-live="polite">
        {message && <p className="login-box__message">{message}</p>}
        {error && <p className="login-box__error">{error}</p>}
        {isLoggedIn && (
          <button type="button" onClick={signOut} className="logout-btn" disabled={isWorking}>
            Sign Out
          </button>
        )}
      </div>
    </section>
  );
}
