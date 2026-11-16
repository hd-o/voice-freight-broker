"use client";

import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useAccount } from "@/lib/account";
import { Navigation, type NavigationPage } from "@/components/navigation/navigation";
import { applicationShellContext } from "./application-layout";

export function SharedApplicationLayout({ children }: { children: ReactNode }): React.JSX.Element {
  const pathname = usePathname();
  const router = useRouter();
  const account = useAccount();
  const activePage = pathname.startsWith("/dashboard") ? "dashboard" : "call";

  return (
    <applicationShellContext.Provider value>
      <div className="min-h-svh bg-background text-foreground">
        <a
          href="#main-content"
          className="fixed top-3 left-3 z-50 -translate-y-24 rounded-lg bg-primary px-4 py-3 text-primary-foreground focus:translate-y-0"
        >
          Skip to content
        </a>
        <Navigation
          activePage={activePage}
          signedIn={!!account.user}
          accountName={account.user?.name}
          accountPending={account.pending}
          accountLoading={account.loading}
          onNavigate={(page: NavigationPage): void => router.push(`/${page}`)}
          onAccountAction={account.performAccountAction}
        />
        <main
          id="main-content"
          tabIndex={-1}
          className="min-w-0 px-4 pt-8 pb-[calc(6rem+env(safe-area-inset-bottom))] focus:outline-none md:pt-10 md:pr-4 md:pb-12 md:pl-28"
        >
          {children}
        </main>
      </div>
    </applicationShellContext.Provider>
  );
}
