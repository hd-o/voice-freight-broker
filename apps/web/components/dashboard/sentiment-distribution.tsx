const sentimentTones = {
  Positive: "bg-foreground",
  Neutral: "bg-muted-foreground",
  Negative: "bg-muted-foreground/65",
  Unknown: "bg-muted-foreground/30",
} as const;

export type SentimentSegment = {
  label: keyof typeof sentimentTones;
  count: number;
  percentage: number;
};

export type SentimentDistributionProps = {
  segments: readonly SentimentSegment[];
  description: string;
};

export function renderSentimentDistribution({ segments, description }: SentimentDistributionProps): React.JSX.Element {
  return (
    <section aria-label="Caller sentiment" className="min-w-0 rounded-[10px] bg-muted p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Caller sentiment</h2>
        <p className="text-xs leading-4 text-muted-foreground">{description}</p>
      </div>
      <div aria-hidden="true" className="mt-4 flex h-2 overflow-hidden rounded-full bg-border">
        {segments.map((segment): React.JSX.Element => (
          <span
            key={segment.label}
            className={sentimentTones[segment.label]}
            style={{ width: `${segment.percentage}%` }}
          />
        ))}
      </div>
      {segments.length ? (
        <ul className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs leading-4 sm:grid-cols-4">
          {segments.map((segment): React.JSX.Element => (
            <li key={segment.label} className="flex items-center gap-2">
              <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${sentimentTones[segment.label]}`} />
              <span>
                {segment.label} {segment.count} · {segment.percentage}%
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">Sentiment will appear after calls have been analyzed.</p>
      )}
    </section>
  );
}
