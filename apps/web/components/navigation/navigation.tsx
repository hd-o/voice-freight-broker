"use client";

import { LayoutGrid, Phone } from "lucide-react";
import { renderButton as Button } from "@/components/ui/button";
import { renderAccountAction as AccountAction } from "./account-action";

export type NavigationPage = "call" | "dashboard";
export type NavigationProps = {
  activePage: NavigationPage;
  signedIn: boolean;
  onNavigate: (page: NavigationPage) => void;
  onAccountAction: () => void;
};

export function renderNavigation({
  activePage,
  signedIn,
  onNavigate,
  onAccountAction,
}: NavigationProps) {
  return (
    <nav
      aria-label="Main navigation"
      className="fixed inset-x-0 bottom-0 z-20 flex items-center justify-around border-t border-border bg-background px-4 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] md:inset-x-auto md:top-0 md:left-0 md:w-16 md:flex-col md:justify-center md:border-t-0 md:border-r md:p-2.5"
    >
      <div className="contents md:flex md:flex-col md:gap-2">
        <Button
          size="icon"
          variant={activePage === "call" ? "default" : "secondary"}
          aria-label="Call"
          title="Call"
          aria-current={activePage === "call" ? "page" : undefined}
          onClick={() => onNavigate("call")}
        >
          <Phone size={20} strokeWidth={1.75} aria-hidden="true" />
        </Button>
        <Button
          size="icon"
          variant={activePage === "dashboard" ? "default" : "secondary"}
          aria-label="Dashboard"
          title="Dashboard"
          aria-current={activePage === "dashboard" ? "page" : undefined}
          onClick={() => onNavigate("dashboard")}
        >
          <LayoutGrid size={20} strokeWidth={1.75} aria-hidden="true" />
        </Button>
      </div>
      <div className="md:absolute md:bottom-2.5">
        <AccountAction signedIn={signedIn} onAccountAction={onAccountAction} />
      </div>
    </nav>
  );
}
