"use client";

import { LogIn, LogOut } from "lucide-react";
import { renderButton as Button } from "@/components/ui/button";

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
    <Button
      variant="secondary"
      size="icon"
      aria-label={label}
      title={label}
      onClick={onAccountAction}
    >
      <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
    </Button>
  );
}
