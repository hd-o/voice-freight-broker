import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { mergeClasses } from "@/lib/classes";

const getBadgeClasses = cva(
  "inline-flex max-w-full items-center gap-1 rounded-md px-2 py-0.5 text-xs leading-4 font-medium [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-muted text-foreground",
        success:
          "bg-emerald-100 text-emerald-800 [[data-theme=dark]_&]:bg-emerald-950 [[data-theme=dark]_&]:text-emerald-200",
        warning:
          "bg-amber-100 text-amber-900 [[data-theme=dark]_&]:bg-amber-950 [[data-theme=dark]_&]:text-amber-200",
        destructive: "bg-destructive text-destructive-foreground",
        outline: "border border-border text-muted-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export type BadgeProps = ComponentProps<"span"> &
  VariantProps<typeof getBadgeClasses>;

export function renderBadge({ className, variant, ...props }: BadgeProps) {
  return (
    <span
      data-slot="badge"
      className={mergeClasses(getBadgeClasses({ variant }), className)}
      {...props}
    />
  );
}
