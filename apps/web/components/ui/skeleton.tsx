import type { ComponentProps } from "react";
import { mergeClasses } from "@/lib/classes";

export type SkeletonProps = ComponentProps<"div">;

export function renderSkeleton({ className, ...props }: SkeletonProps) {
  return (
    <div
      data-slot="skeleton"
      className={mergeClasses("rounded-md bg-muted", className)}
      {...props}
      aria-hidden="true"
    />
  );
}
