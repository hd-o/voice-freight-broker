"use client";

import { LogIn, LogOut } from "lucide-react";
import { renderButton as Button } from "@/components/ui/button";
import {
  renderTooltip as Tooltip,
  renderTooltipTrigger as TooltipTrigger,
  renderTooltipContent as TooltipContent,
} from "@/components/ui/tooltip";

export type AccountActionProps = {
  signedIn: boolean;
  onAccountAction: () => void;
};

export function renderAccountAction({
  signedIn,
  onAccountAction,
}: AccountActionProps) {
  const label = signedIn ? "Sign out" : "Sign in";
  const Icon = signedIn ? LogOut : LogIn;

  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button variant="secondary" size="icon" />}
        aria-label={label}
        onClick={onAccountAction}
      >
        <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
