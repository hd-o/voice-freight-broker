import { renderBadge as Badge } from "@/components/ui/badge";
import { renderLoadSelector as LoadSelector, type LoadSelectorProps } from "./load-selector";

export type NegotiationEntry = {
  label: string;
  value: string;
  emphasized?: boolean;
};

export type LoadDetails = {
  route: string;
  rate: string;
  comparison: string;
  snapshot: readonly string[];
  negotiation: readonly NegotiationEntry[];
};

export type LoadSummaryProps = {
  outcome: string;
  eligibility: string;
  carrier: string;
  mcNumber: string;
  selector: LoadSelectorProps;
  load: LoadDetails | null;
};

export function renderLoadSummary({
  outcome,
  eligibility,
  carrier,
  mcNumber,
  selector,
  load,
}: LoadSummaryProps): React.JSX.Element {
  return (
    <section
      aria-label="Call and load summary"
      className="min-w-0 rounded-[10px] border border-border bg-surface p-6 [overflow-wrap:anywhere]"
    >
      <div className="flex flex-wrap gap-2">
        <Badge>{outcome}</Badge>
        <Badge>{eligibility}</Badge>
      </div>
      <div className="mt-3 space-y-2 rounded-lg bg-muted p-4">
        <h2 className="text-sm font-semibold">Carrier verification</h2>
        <p>
          {carrier} · MC {mcNumber}
        </p>
      </div>
      <div className="mt-3">
        <LoadSelector {...selector} />
      </div>
      {load ? (
        <>
          <h2 className="mt-3 text-2xl leading-8 font-semibold tracking-tight">{load.route}</h2>
          <p className="mt-3 text-3xl leading-9 font-semibold tracking-tight">{load.rate}</p>
          <p className="mt-3 text-muted-foreground">{load.comparison}</p>
          <div className="mt-3 rounded-lg bg-muted p-4">
            <h3 className="mb-2 text-sm font-semibold">Load snapshot</h3>
            {load.snapshot.map((line): React.JSX.Element => (
              <p key={line}>{line}</p>
            ))}
          </div>
          <div className="mt-3 rounded-lg bg-muted p-4">
            <h3 className="mb-2 text-sm font-semibold">Negotiation</h3>
            <dl className="space-y-2">
              {load.negotiation.map((entry): React.JSX.Element => (
                <div
                  key={entry.label}
                  className={`flex justify-between gap-4 ${entry.emphasized ? "font-semibold" : ""}`}
                >
                  <dt>{entry.label}</dt>
                  <dd className="shrink-0 tabular-nums">{entry.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </>
      ) : (
        <div className="mt-4 rounded-lg bg-muted p-4">
          <h2 className="font-semibold">{selector.options.length ? "Load unavailable" : "No load selected"}</h2>
          <p className="mt-2 text-muted-foreground">
            {selector.options.length
              ? "The selected load is not part of this call. Choose an available load above."
              : "No load details were recorded for this call."}
          </p>
        </div>
      )}
    </section>
  );
}
