"use client";

import { useId } from "react";
import { renderButton as Button } from "@/components/ui/button";

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
  rows: CallRecord[];
  pageLabel: string;
  nextDisabled?: boolean;
  previousVisible?: boolean;
  onCallSelect: (id: string) => void;
  onNext: () => void;
  onPrevious: () => void;
};
export function renderCallHistory({
  rows,
  pageLabel,
  nextDisabled = false,
  previousVisible = false,
  onCallSelect,
  onNext,
  onPrevious,
}: CallHistoryProps) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="min-w-0 rounded-[10px] border border-border bg-surface p-6"
    >
      <h2 id={headingId} className="text-xl leading-7 font-semibold">
        Call history
      </h2>
      <p className="mt-4 text-muted-foreground">
        Select a call to inspect its details
      </p>
      {rows.length ? (
        <div
          role="region"
          aria-label="Call history table"
          tabIndex={0}
          className="mt-4 overflow-x-auto rounded-t-lg"
        >
          <table className="w-full min-w-[1100px] border-collapse text-left text-sm">
            <caption className="sr-only">
              Call history with source, carrier, load, outcome, agreements,
              rate, sentiment and analysis status
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
                ].map((heading) => (
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
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className="h-14 border-b border-border hover:bg-muted/50 focus-within:bg-muted/50"
                >
                  <th
                    scope="row"
                    className="px-3 py-4 font-normal whitespace-nowrap"
                  >
                    <button
                      type="button"
                      className="rounded text-left hover:underline"
                      aria-label={`View call from ${row.carrier}, ${row.date}`}
                      onClick={() => onCallSelect(row.id)}
                    >
                      {row.date}
                    </button>
                  </th>
                  <td className="px-3 py-4">{row.source}</td>
                  <td className="max-w-56 px-3 py-4 break-words">
                    {row.carrier}
                  </td>
                  <td className="max-w-60 px-3 py-4 break-words">{row.load}</td>
                  <td className="px-3 py-4">{row.outcome}</td>
                  <td className="px-3 py-4 tabular-nums">{row.agreements}</td>
                  <td className="px-3 py-4 whitespace-nowrap tabular-nums">
                    {row.rate}
                  </td>
                  <td className="px-3 py-4">{row.sentiment}</td>
                  <td className="px-3 py-4">{row.analysis}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mt-4 rounded-lg bg-muted px-6 py-12 text-center">
          <p className="font-medium">No calls yet</p>
          <p className="mt-2 text-muted-foreground">
            Your call history will appear here.
          </p>
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
