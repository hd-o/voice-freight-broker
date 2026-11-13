"use client";

import { LogIn, LogOut } from "lucide-react";
import { useEffect, useState } from "react";
import { renderButton as Button } from "@/components/ui/button";
import {
  renderTooltip as Tooltip,
  renderTooltipTrigger as TooltipTrigger,
  renderTooltipContent as TooltipContent,
} from "@/components/ui/tooltip";

export type AccountActionProps = {
  signedIn: boolean;
  pending?: boolean;
  onAccountAction: () => void;
};

export function renderAccountAction({
  signedIn,
  pending = false,
  onAccountAction,
}: AccountActionProps) {
  const [readiness, setReadiness] = useState(false);
  useEffect(() => {
    setReadiness(true);
  }, []);
  const label = signedIn ? "Sign out" : "Sign in";
  const Icon = signedIn ? LogOut : LogIn;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="secondary"
            size="icon"
            disabled={!readiness || pending}
          />
        }
        aria-label={label}
        disabled={!readiness || pending}
        aria-busy={pending || undefined}
        onClick={onAccountAction}
      >
        <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
