"use client";

import { useSyncExternalStore } from "react";
import type { NavigationPage } from "@/components/navigation/navigation";

function subscribeNavigation(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);

  return (): void => window.removeEventListener("popstate", onChange);
}

function readQuery(): string {
  return window.location.search;
}

function readServerQuery(): null {
  return null;
}

export function useQueryParameters(): { parameters: URLSearchParams; readiness: boolean } {
  const query = useSyncExternalStore<string | null>(subscribeNavigation, readQuery, readServerQuery);

  return {
    parameters: new URLSearchParams(query ?? ""),
    readiness: query !== null,
  };
}

export function changeQuery(parameters: URLSearchParams): void {
  const query = parameters.toString();

  window.history.pushState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function navigatePage(page: NavigationPage): void {
  window.location.assign(`/${page}`);
}

export function createCallHref(id: string, page = 1): string {
  const parameters = new URLSearchParams({ call: id });

  if (page > 1) {
    parameters.set("page", String(page));
  }

  return `/dashboard/call?${parameters}`;
}
