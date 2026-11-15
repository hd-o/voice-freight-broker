"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import "@fontsource-variable/inter";
// vinext's static client manifest includes styles imported by client components.
import "@/app/globals.css";
import { AccountProvider } from "@/lib/account";

export function Providers({ children }: { children: ReactNode }): React.JSX.Element {
  const [queryClient] = useState((): QueryClient => new QueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <AccountProvider>{children}</AccountProvider>
    </QueryClientProvider>
  );
}
