import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { mergeClasses } from "@/lib/classes";

const getBadgeClasses = cva(
  "inline-flex max-w-full items-center gap-1 rounded-md px-2 py-0.5 text-xs leading-4 font-medium [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-muted text-foreground",
        success: "bg-success text-success-foreground",
        warning: "bg-warning text-warning-foreground",
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
