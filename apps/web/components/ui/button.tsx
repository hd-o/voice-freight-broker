"use client";

import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { mergeClasses } from "@/lib/classes";

const getButtonClasses = cva(
  "inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-disabled:pointer-events-none data-disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:opacity-90",
        outline: "border border-border bg-background hover:bg-black/5",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

type ButtonProps = ButtonPrimitive.Props &
  VariantProps<typeof getButtonClasses>;

export function renderButton({ className, variant, ...props }: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={(state) =>
        mergeClasses(
          getButtonClasses({ variant }),
          typeof className === "function" ? className(state) : className,
        )
      }
      {...props}
    />
  );
}
