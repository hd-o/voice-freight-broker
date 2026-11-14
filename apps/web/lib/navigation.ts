"use client";

import { useSyncExternalStore } from "react";
import type { NavigationPage } from "@/components/navigation/navigation";

function subscribeNavigation(onChange: () => void) {
  window.addEventListener("popstate", onChange);

  return () => window.removeEventListener("popstate", onChange);
}

function readQuery() {
  return window.location.search;
}

function readServerQuery() {
  return null;
}

export function useQueryParameters() {
  const query = useSyncExternalStore<string | null>(subscribeNavigation, readQuery, readServerQuery);

  return {
    parameters: new URLSearchParams(query ?? ""),
    readiness: query !== null,
  };
}

export function changeQuery(parameters: URLSearchParams) {
  const query = parameters.toString();

  window.history.pushState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function navigatePage(page: NavigationPage) {
  window.location.assign(`/${page}`);
}

export function createCallHref(id: string, page = 1) {
  const parameters = new URLSearchParams({ call: id });

  if (page > 1) {
    parameters.set("page", String(page));
  }

  return `/dashboard/call?${parameters}`;
}
