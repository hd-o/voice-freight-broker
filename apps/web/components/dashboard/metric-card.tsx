import { mergeClasses } from "@/lib/classes";

export type MetricCardProps = {
  label: string;
  value: string;
  description: string;
  className?: string;
};

export function renderMetricCard({ label, value, description, className }: MetricCardProps): React.JSX.Element {
  return (
    <div className={mergeClasses("min-w-0 rounded-[10px] bg-muted p-6", className)}>
      <dl className="space-y-2">
        <dt className="text-sm leading-5">{label}</dt>
        <dd className="break-words text-2xl leading-8 font-semibold tracking-tight">{value}</dd>
      </dl>
      <p className="mt-2 text-xs leading-4 text-muted-foreground">{description}</p>
    </div>
  );
}
