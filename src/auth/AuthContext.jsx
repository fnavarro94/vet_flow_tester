import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { AUTH_HEADER_NAMES, DEFAULT_API_HOST, VET_API_PATH } from "../config.jsx";
const STORAGE_KEY_AUTH = "vetTesterAuth";
const STORAGE_KEY_HOST = "vetTesterApiHost";

const AuthContext = createContext(null);

const safeReadStorage = (key, fallback = null) => {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};

const safeWriteStorage = (key, value) => {
  if (typeof window === "undefined") return;
  try {
    if (value === null || value === undefined) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, JSON.stringify(value));
    }
  } catch {}
};

const normaliseHost = (host) => {
  if (!host) return DEFAULT_API_HOST;
  const trimmed = String(host).trim();
  if (!trimmed) return DEFAULT_API_HOST;
  return trimmed.replace(/\/+$/, "");
};

export function AuthProvider({ children }) {
  const initialAuth = useMemo(() => safeReadStorage(STORAGE_KEY_AUTH, {}), []);
  const initialHost = useMemo(
    () => normaliseHost(safeReadStorage(STORAGE_KEY_HOST, DEFAULT_API_HOST)),
    []
  );

  const [apiHost, setApiHostState] = useState(initialHost);
  const [token, setToken] = useState(initialAuth?.token || null);
  const [refreshToken, setRefreshToken] = useState(initialAuth?.refreshToken || null);
  const [userId, setUserId] = useState(initialAuth?.userId || null);
  const [userEmail, setUserEmail] = useState(initialAuth?.userEmail || null);

  const [pendingSession, setPendingSession] = useState(null);
  const [pendingEmail, setPendingEmail] = useState(null);
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);

  const apiBase = useMemo(() => `${apiHost}${VET_API_PATH}`, [apiHost]);

  useEffect(() => {
    safeWriteStorage(STORAGE_KEY_HOST, apiHost);
  }, [apiHost]);

  useEffect(() => {
    if (!token) {
      safeWriteStorage(STORAGE_KEY_AUTH, null);
      return;
    }
    safeWriteStorage(STORAGE_KEY_AUTH, {
      token,
      refreshToken,
      userId,
      userEmail,
    });
  }, [token, refreshToken, userId, userEmail]);

  const clearAuth = useCallback(() => {
    setToken(null);
    setRefreshToken(null);
    setUserId(null);
    setUserEmail(null);
    setPendingSession(null);
    setPendingEmail(null);
  }, []);

  const signOut = useCallback(() => {
    clearAuth();
    setMessage("Signed out");
  }, [clearAuth]);

  const resetStatus = useCallback(() => {
    setError(null);
    setMessage(null);
  }, []);

  const updateApiHost = useCallback(
    (next) => {
      setApiHostState(normaliseHost(next));
    },
    []
  );

  const signIn = useCallback(
    async (email) => {
      const targetEmail = String(email || "").trim();
      if (!targetEmail) {
        setError("Email is required");
        return;
      }
      setIsWorking(true);
      setError(null);
      setMessage(null);
      setPendingSession(null);
      setPendingEmail(null);
      try {
        const res = await fetch(`${apiHost}/vets/sign-in`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({ email: targetEmail }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data?.success === false) {
          const errMsg = data?.error_details?.[0]?.message || data?.message || data?.error || `HTTP ${res.status}`;
          throw new Error(errMsg || "Sign-in failed");
        }
        const session = typeof data?.data === "string" ? data.data : data?.data?.session;
        if (!session) throw new Error("Missing session token in response");
        setPendingSession(session);
        setPendingEmail(targetEmail);
        setMessage("Verification code sent. Check your email.");
        return session;
      } catch (err) {
        setError(err?.message || "Sign-in failed");
        throw err;
      } finally {
        setIsWorking(false);
      }
    },
    [apiHost]
  );

  const confirmSignIn = useCallback(
    async (code) => {
      const trimmed = String(code || "").trim();
      if (!pendingSession || !pendingEmail) {
        setError("Start sign-in with an email first");
        return;
      }
      if (!trimmed) {
        setError("Code is required");
        return;
      }
      setIsWorking(true);
      setError(null);
      setMessage(null);
      try {
        const res = await fetch(`${apiHost}/vets/confirm-sign-in`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            email: pendingEmail,
            code: trimmed,
            session: pendingSession,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data?.success === false) {
          const errMsg = data?.error_details?.[0]?.message || data?.message || data?.error || `HTTP ${res.status}`;
          throw new Error(errMsg || "Confirm sign-in failed");
        }
        const payload = data?.data || {};
        if (!payload?.access_token) throw new Error("Missing access token in response");
        setToken(payload.access_token);
        setRefreshToken(payload.refresh_token || null);
        setUserId(payload.user_id || null);
        setUserEmail(pendingEmail);
        setPendingSession(null);
        setPendingEmail(null);
        setMessage("Signed in successfully");
        return payload.access_token;
      } catch (err) {
        setError(err?.message || "Confirm sign-in failed");
        throw err;
      } finally {
        setIsWorking(false);
      }
    },
    [apiHost, pendingEmail, pendingSession]
  );

  const authFetch = useCallback(
    async (input, init = {}) => {
      const headers = new Headers(init.headers || {});
      if (token) headers.set("authorization", `Bearer ${token}`);
      if (refreshToken) headers.set(AUTH_HEADER_NAMES.refresh, refreshToken);

      const response = await fetch(input, { ...init, headers });

      const nextAccess = response.headers.get(AUTH_HEADER_NAMES.access);
      if (nextAccess && nextAccess !== token) setToken(nextAccess);

      const nextRefresh = response.headers.get(AUTH_HEADER_NAMES.refresh);
      if (nextRefresh && nextRefresh !== refreshToken) setRefreshToken(nextRefresh);

      return response;
    },
    [token, refreshToken]
  );

  const value = useMemo(
    () => ({
      apiHost,
      apiBase,
      setApiHost: updateApiHost,
      token,
      refreshToken,
      userEmail,
      userId,
      isLoggedIn: Boolean(token),
      pendingEmail,
      pendingSession,
      isWorking,
      error,
      message,
      signIn,
      confirmSignIn,
      signOut,
      authFetch,
      clearAuth,
      resetStatus,
    }),
    [
      apiHost,
      apiBase,
      updateApiHost,
      token,
      refreshToken,
      userEmail,
      userId,
      pendingEmail,
      pendingSession,
      isWorking,
      error,
      message,
      signIn,
      confirmSignIn,
      signOut,
      authFetch,
      clearAuth,
      resetStatus,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}

export const AUTH_DEFAULTS = {
  host: DEFAULT_API_HOST,
  path: VET_API_PATH,
};
