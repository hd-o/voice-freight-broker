import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function mergeClasses(...values: ClassValue[]) {
  return twMerge(clsx(values));
}

// shadcn-generated components import this conventional alias.
export { mergeClasses as cn };
