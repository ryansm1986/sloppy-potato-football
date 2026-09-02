import { useCallback, useEffect, useState } from "react";
import { RESEARCH_OWNER_TOKEN_KEY } from "./research-api";

const OWNER_ACCESS_CHANGED_EVENT = "spff:research-owner-access-changed";

function readOwnerToken(): string {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(RESEARCH_OWNER_TOKEN_KEY)?.trim() ?? "";
}

export function useResearchOwnerAccess() {
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

  return { ownerToken, revision, saveOwnerToken, removeOwnerToken };
}
