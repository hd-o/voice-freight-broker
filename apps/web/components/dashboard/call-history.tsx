"use client";

import { useId } from "react";
import { Button } from "@/components/ui/button";

export type CallRecord = {
  id: string;
  date: string;
  source: "Live" | "Sample";
  carrier: string;
  load: string;
  outcome: string;
  agreements: string;
  rate: string;
  sentiment: string;
  analysis: "Complete" | "Pending" | "Failed";
};

export type CallHistoryProps = {
  rows: readonly CallRecord[];
  pageLabel: string;
  nextDisabled?: boolean;
  previousVisible?: boolean;
  getCallHref: (id: string) => string;
  onNext: () => void;
  onPrevious: () => void;
};

export function CallHistory({
  rows,
  pageLabel,
  nextDisabled = false,
  previousVisible = false,
  getCallHref,
  onNext,
  onPrevious,
}: CallHistoryProps): React.JSX.Element {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="min-w-0 rounded-[10px] border border-border bg-surface p-6">
      <h2 id={headingId} className="text-xl leading-7 font-semibold">
        Call history
      </h2>
      <p className="mt-4 text-muted-foreground">Select a call to inspect its details</p>
      {rows.length ? (
        <div role="region" aria-label="Call history table" tabIndex={0} className="mt-4 overflow-x-auto rounded-t-lg">
          <table className="w-full min-w-[1100px] border-collapse text-left text-sm">
            <caption className="sr-only">
              Call history with source, carrier, load, outcome, agreements, rate, sentiment and analysis status
            </caption>
            <thead className="bg-muted text-xs leading-4 text-muted-foreground">
              <tr>
                {[
                  "Date",
                  "Source",
                  "Carrier",
                  "Load",
                  "Outcome",
                  "Final agreements",
                  "Agreed rate",
                  "Sentiment",
                  "Analysis",
                ].map((heading): React.JSX.Element => (
                  <th
                    key={heading}
                    scope="col"
                    className="border-b border-border px-3 py-3 font-normal whitespace-nowrap"
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((call): React.JSX.Element => (
                <tr
                  key={call.id}
                  className="relative h-14 border-b border-border hover:bg-muted/50 focus-within:bg-muted/50"
                >
                  <th scope="row" className="px-3 py-4 font-normal whitespace-nowrap">
                    <a
                      href={getCallHref(call.id)}
                      className="rounded text-left after:absolute after:inset-0"
                      aria-label={`View call from ${call.carrier}, ${call.date}`}
                    >
                      {call.date}
                    </a>
                  </th>
                  <td className="px-3 py-4">{call.source}</td>
                  <td className="max-w-56 px-3 py-4 break-words">{call.carrier}</td>
                  <td className="max-w-60 px-3 py-4 break-words">{call.load}</td>
                  <td className="px-3 py-4">{call.outcome}</td>
                  <td className="px-3 py-4 tabular-nums">{call.agreements}</td>
                  <td className="px-3 py-4 whitespace-nowrap tabular-nums">{call.rate}</td>
                  <td className="px-3 py-4">{call.sentiment}</td>
                  <td className="px-3 py-4">{call.analysis}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mt-4 rounded-lg bg-muted px-6 py-12 text-center">
          <p className="font-medium">No calls yet</p>
          <p className="mt-2 text-muted-foreground">Your call history will appear here.</p>
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
        <p className="text-xs leading-4 text-muted-foreground">{pageLabel}</p>
        <div className="flex gap-2">
          {previousVisible ? (
            <Button variant="outline" onClick={onPrevious}>
              Previous
            </Button>
          ) : null}
          {rows.length ? (
            <Button variant="outline" disabled={nextDisabled} onClick={onNext}>
              Next
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
