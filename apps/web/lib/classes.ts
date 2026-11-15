import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function mergeClasses(...classValues: ClassValue[]): string {
  return twMerge(clsx(classValues));
}

// shadcn-generated components import this conventional alias.
export { mergeClasses as cn };
