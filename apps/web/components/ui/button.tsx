"use client";

import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { mergeClasses } from "@/lib/classes";

export const getButtonClasses = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] text-sm leading-5 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:opacity-90",
        outline: "border border-border bg-surface text-foreground hover:bg-muted",
        secondary: "bg-muted text-foreground hover:opacity-80",
        ghost: "bg-transparent text-foreground hover:bg-muted",
        destructive: "bg-destructive text-destructive-foreground hover:opacity-80",
      },
      size: {
        default: "min-h-10 px-4 py-2",
        small: "min-h-8 rounded-lg px-3 py-1.5 text-xs leading-4",
        icon: "size-11 p-3",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export type ButtonProps = ButtonPrimitive.Props & VariantProps<typeof getButtonClasses>;

export function renderButton({ className, variant, size, ...props }: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={(state) =>
        mergeClasses(
          getButtonClasses({ variant, size }),
          typeof className === "function" ? className(state) : className,
        )
      }
      {...props}
    />
  );
}
