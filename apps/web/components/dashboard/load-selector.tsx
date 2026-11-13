"use client";
import { useId } from "react";
import { Select } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";

export type LoadOption = { value: string; label: string };
export type LoadSelectorProps = {
  options: LoadOption[];
  value: string | null;
  countLabel: string;
  disabled?: boolean;
  open?: boolean;
  onValueChange: (value: string | null) => void;
  onOpenChange?: (open: boolean) => void;
};
export function renderLoadSelector({
  options,
  value,
  countLabel,
  disabled = false,
  open,
  onValueChange,
  onOpenChange,
}: LoadSelectorProps) {
  const labelId = useId();
  return (
    <div className="min-w-0 space-y-2">
      <span
        id={labelId}
        className="block text-xs leading-4 text-muted-foreground"
      >
        Load
      </span>
      <Select.Root<string>
        items={options}
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        open={open}
        onOpenChange={onOpenChange}
      >
        <Select.Trigger
          aria-labelledby={labelId}
          className="flex min-h-10 w-full items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-left data-disabled:opacity-50"
        >
          <Select.Value
            className="min-w-0 flex-1 truncate"
            placeholder="No load selected"
          />
          <span
            aria-hidden="true"
            className="shrink-0 text-xs text-muted-foreground"
          >
            {countLabel}
          </span>
          <Select.Icon>
            <ChevronDown size={16} className="text-muted-foreground" />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner
            sideOffset={4}
            className="z-50 outline-none"
            alignItemWithTrigger={false}
          >
            <Select.Popup className="max-h-[var(--available-height)] w-[var(--anchor-width)] overflow-y-auto rounded-lg border border-border bg-surface p-1 text-foreground shadow-lg">
              <Select.List>
                {options.map((option) => (
                  <Select.Item
                    key={option.value}
                    value={option.value}
                    className="flex min-h-10 cursor-pointer items-center gap-3 rounded-md px-3 py-2 outline-none data-highlighted:bg-muted"
                  >
                    <Select.ItemText className="min-w-0 flex-1 break-words">
                      {option.label}
                    </Select.ItemText>
                    <Select.ItemIndicator>
                      <Check size={16} />
                    </Select.ItemIndicator>
                  </Select.Item>
                ))}
              </Select.List>
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
    </div>
  );
}
