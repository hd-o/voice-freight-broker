"use client";

import type { ComponentProps } from "react";
import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import { Button } from "@/components/ui/button";
import { mergeClasses } from "@/lib/classes";

export function AlertDialog(props: AlertDialogPrimitive.Root.Props): React.JSX.Element {
  return <AlertDialogPrimitive.Root {...props} />;
}

export function AlertDialogContent({ className, ...props }: AlertDialogPrimitive.Popup.Props): React.JSX.Element {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Backdrop
        data-slot="alert-dialog-overlay"
        className="fixed inset-0 isolate z-50 bg-black/10 supports-backdrop-filter:backdrop-blur-xs"
      />
      <AlertDialogPrimitive.Popup
        data-slot="alert-dialog-content"
        className={(state): string =>
          mergeClasses(
            "fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-xl bg-surface p-4 text-foreground ring-1 ring-foreground/10 outline-none",
            typeof className === "function" ? className(state) : className,
          )
        }
        {...props}
      />
    </AlertDialogPrimitive.Portal>
  );
}

export function AlertDialogHeader({ className, ...props }: ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      data-slot="alert-dialog-header"
      className={mergeClasses("grid gap-1.5 text-center sm:text-left", className)}
      {...props}
    />
  );
}

export function AlertDialogFooter({ className, ...props }: ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={mergeClasses(
        "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t border-border bg-muted/50 p-4 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

export function AlertDialogTitle({ className, ...props }: AlertDialogPrimitive.Title.Props): React.JSX.Element {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={(state): string =>
        mergeClasses("text-base font-medium", typeof className === "function" ? className(state) : className)
      }
      {...props}
    />
  );
}

export function AlertDialogDescription({
  className,
  ...props
}: AlertDialogPrimitive.Description.Props): React.JSX.Element {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={(state): string =>
        mergeClasses(
          "text-sm text-balance text-muted-foreground sm:text-pretty",
          typeof className === "function" ? className(state) : className,
        )
      }
      {...props}
    />
  );
}

export function AlertDialogAction(props: ComponentProps<typeof Button>): React.JSX.Element {
  return <Button data-slot="alert-dialog-action" {...props} />;
}

export function AlertDialogCancel(props: AlertDialogPrimitive.Close.Props): React.JSX.Element {
  return (
    <AlertDialogPrimitive.Close data-slot="alert-dialog-cancel" render={<Button variant="outline" />} {...props} />
  );
}
