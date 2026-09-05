import { useCallback, useEffect, useState } from "react";
import { RESEARCH_OWNER_TOKEN_KEY } from "./research-api";
import { useAuth } from "../auth/AuthProvider";

const OWNER_ACCESS_CHANGED_EVENT = "spff:research-owner-access-changed";

function readOwnerToken(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(RESEARCH_OWNER_TOKEN_KEY)?.trim() ?? "";
}

export function useResearchOwnerAccess() {
  const auth = useAuth();
  const [ownerToken, setOwnerToken] = useState(readOwnerToken);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const sync = () => {
      setOwnerToken(readOwnerToken());
      setRevision((current) => current + 1);
    };
    window.addEventListener("storage", sync);
    window.addEventListener(OWNER_ACCESS_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(OWNER_ACCESS_CHANGED_EVENT, sync);
    };
  }, []);

  const saveOwnerToken = useCallback((value: string) => {
    const cleanToken = value.trim();
    if (cleanToken) window.localStorage.setItem(RESEARCH_OWNER_TOKEN_KEY, cleanToken);
    else window.localStorage.removeItem(RESEARCH_OWNER_TOKEN_KEY);
    window.dispatchEvent(new Event(OWNER_ACCESS_CHANGED_EVENT));
  }, []);

  const removeOwnerToken = useCallback(() => {
    window.localStorage.removeItem(RESEARCH_OWNER_TOKEN_KEY);
    window.dispatchEvent(new Event(OWNER_ACCESS_CHANGED_EVENT));
  }, []);

  const google = auth.mode === "google";
  const isOwner = google ? auth.authenticated && auth.user?.role === "owner" : Boolean(ownerToken);
  const canResearch = google ? auth.authenticated && ["owner", "researcher"].includes(auth.user?.role ?? "") : Boolean(ownerToken);
  return { ownerToken: google ? "" : ownerToken, revision, saveOwnerToken, removeOwnerToken, google, isOwner, canResearch, canRead: google ? auth.authenticated : Boolean(ownerToken), userId: auth.user?.id };
}
