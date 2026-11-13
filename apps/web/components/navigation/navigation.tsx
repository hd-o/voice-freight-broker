"use client";

import { LayoutGrid, Phone } from "lucide-react";
import { getButtonClasses } from "@/components/ui/button";
import {
  renderTooltip as Tooltip,
  renderTooltipTrigger as TooltipTrigger,
  renderTooltipContent as TooltipContent,
  renderTooltipProvider as TooltipProvider,
} from "@/components/ui/tooltip";
import { renderAccountAction as AccountAction } from "./account-action";

const navigationItems = [
  { page: "call", label: "Call", icon: Phone },
  { page: "dashboard", label: "Dashboard", icon: LayoutGrid },
] as const;

export type NavigationPage = (typeof navigationItems)[number]["page"];

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
    <TooltipProvider delay={0}>
      <nav
        aria-label="Main navigation"
        className="fixed inset-x-0 bottom-0 z-20 flex items-center justify-around border-t border-border bg-background px-4 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] md:inset-x-auto md:top-0 md:left-0 md:w-16 md:flex-col md:justify-center md:border-t-0 md:border-r md:p-2.5"
      >
        <div className="contents md:flex md:flex-col md:gap-2">
          {navigationItems.map(({ page, label, icon: Icon }) => (
            <Tooltip key={page}>
              <TooltipTrigger
                render={
                  <a
                    href={`/${page}`}
                    className={getButtonClasses({
                      size: "icon",
                      variant: activePage === page ? "default" : "secondary",
                    })}
                  />
                }
                aria-label={label}
                aria-current={activePage === page ? "page" : undefined}
                onClick={(event) => {
                  if (
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return;

                  event.preventDefault();
                  onNavigate(page);
                }}
              >
                <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent side="right">{label}</TooltipContent>
            </Tooltip>
          ))}
        </div>
        <div className="md:absolute md:bottom-2.5">
          <AccountAction
            signedIn={signedIn}
            onAccountAction={onAccountAction}
          />
        </div>
      </nav>
    </TooltipProvider>
  );
}
