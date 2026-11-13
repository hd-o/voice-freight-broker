"use client";

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { mergeClasses } from "@/lib/classes";

export type TooltipProviderProps = TooltipPrimitive.Provider.Props;

export type TooltipProps = TooltipPrimitive.Root.Props;

export type TooltipTriggerProps = TooltipPrimitive.Trigger.Props;

export type TooltipContentProps = TooltipPrimitive.Popup.Props &
  Pick<
    TooltipPrimitive.Positioner.Props,
    "side" | "sideOffset" | "align" | "alignOffset"
  >;

export function renderTooltipProvider({
  delay = 300,
  ...props
}: TooltipProviderProps) {
  return <TooltipPrimitive.Provider delay={delay} {...props} />;
}

export function renderTooltip(props: TooltipProps) {
  return <TooltipPrimitive.Root {...props} />;
}

export function renderTooltipTrigger(props: TooltipTriggerProps) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

export function renderTooltipContent({
  className,
  side = "top",
  sideOffset = 8,
  align = "center",
  alignOffset = 0,
  ...props
}: TooltipContentProps) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        collisionPadding={8}
        className="z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={(state) =>
            mergeClasses(
              "max-w-[min(20rem,var(--available-width))] rounded-md bg-primary px-3 py-1.5 text-xs leading-4 text-primary-foreground shadow-md wrap-anywhere",
              typeof className === "function" ? className(state) : className,
            )
          }
          {...props}
        />
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}
