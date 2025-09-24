export const DEFAULT_API_HOST = "https://api-dev.bepetz.com";
//export const DEFAULT_API_HOST = "https://localhost:8000"
export const VET_API_PATH = "/ai-integrations/vet";
export const DEFAULT_API_BASE = `${DEFAULT_API_HOST}${VET_API_PATH}`;
export const API_BASE = DEFAULT_API_BASE; // legacy export kept for compatibility

export const RELAY_BASE = "https://chatbot-relay-628790375254.us-east1.run.app";

export const AUTH_HEADER_NAMES = {
  access: "x-access-token",
  refresh: "x-refresh-token",
};
