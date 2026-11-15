"use client";

import { LogIn, LogOut } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

export type AccountActionProps = {
  signedIn: boolean;
  pending?: boolean;
  onAccountAction: () => void;
};

export function AccountAction({ signedIn, pending = false, onAccountAction }: AccountActionProps): React.JSX.Element {
  const [readiness, setReadiness] = useState(false);
  useEffect((): void => {
    setReadiness(true);
  }, []);
  const label = signedIn ? "Sign out" : "Sign in";
  const Icon = signedIn ? LogOut : LogIn;

  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button variant="secondary" size="icon" disabled={!readiness || pending} />}
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
