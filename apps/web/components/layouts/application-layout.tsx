"use client";

import type { ReactNode } from "react";
import { renderNavigation as Navigation, type NavigationPage } from "@/components/navigation/navigation";

export type ApplicationLayoutProps = {
  activePage: NavigationPage;
  signedIn: boolean;
  accountName?: string;
  accountPending?: boolean;
  onNavigate: (page: NavigationPage) => void;
  onAccountAction: () => void;
  children: ReactNode;
};

export function renderApplicationLayout({
  activePage,
  signedIn,
  accountName,
  accountPending,
  onNavigate,
  onAccountAction,
  children,
}: ApplicationLayoutProps): React.JSX.Element {
  return (
    <div className="min-h-svh bg-background text-foreground">
      <a
        href="#main-content"
        className="fixed top-3 left-3 z-50 -translate-y-24 rounded-lg bg-primary px-4 py-3 text-primary-foreground focus:translate-y-0"
      >
        Skip to content
      </a>
      <Navigation
        activePage={activePage}
        signedIn={signedIn}
        accountName={accountName}
        accountPending={accountPending}
        onNavigate={onNavigate}
        onAccountAction={onAccountAction}
      />
      <main
        id="main-content"
        tabIndex={-1}
        className="min-w-0 px-4 pt-8 pb-[calc(6rem+env(safe-area-inset-bottom))] focus:outline-none md:pt-10 md:pr-4 md:pb-12 md:pl-28"
      >
        {children}
      </main>
    </div>
  );
}
