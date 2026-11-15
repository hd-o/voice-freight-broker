import type { ComponentProps } from "react";
import { mergeClasses } from "@/lib/classes";

export type SkeletonProps = ComponentProps<"div">;

export function renderSkeleton({ className, ...props }: SkeletonProps): React.JSX.Element {
  return (
    <div
      data-slot="skeleton"
      className={mergeClasses("animate-pulse rounded-md bg-muted", className)}
      {...props}
      aria-hidden="true"
    />
  );
}
