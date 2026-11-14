import { mergeClasses } from "@/lib/classes";

export type TranscriptEntry = {
  id: string;
  speaker: "carrier" | "broker";
  label: string;
  time: string;
  text: string;
};

export type TranscriptProps = {
  entries: readonly TranscriptEntry[];
  heading?: string;
  emptyMessage?: string;
  className?: string;
};

export function renderTranscript({
  entries,
  heading = "Transcript",
  emptyMessage = "Your conversation will appear here when the call starts.",
  className,
}: TranscriptProps) {
  return (
    <section
      aria-label={heading}
      className={mergeClasses("min-w-0 overflow-y-auto rounded-lg bg-muted p-6", className)}
    >
      <h2 className="mb-4 text-sm font-medium">{heading}</h2>
      {entries.length === 0 ? (
        <p className="text-muted-foreground">{emptyMessage}</p>
      ) : (
        <ol className="space-y-4">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className={mergeClasses("flex flex-col gap-1", entry.speaker === "carrier" && "items-end")}
            >
              <span className="text-[11px] leading-4 text-muted-foreground">
                {entry.time} · {entry.label}
              </span>
              <p
                className={mergeClasses(
                  "w-[90%] sm:w-[76%] whitespace-pre-wrap rounded-lg px-3 py-2 [overflow-wrap:anywhere]",
                  entry.speaker === "carrier" ? "bg-primary text-primary-foreground" : "bg-surface text-foreground",
                )}
              >
                {entry.text}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
