"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import "@fontsource-variable/inter";
// vinext's static client manifest includes styles imported by client components.
import "@/app/globals.css";
import { renderAccountProvider as AccountProvider } from "@/lib/account";

export function renderProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <AccountProvider>{children}</AccountProvider>
    </QueryClientProvider>
  );
}
