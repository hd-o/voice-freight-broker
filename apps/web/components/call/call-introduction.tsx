import { renderButton as Button } from "@/components/ui/button";
import { mergeClasses } from "@/lib/classes";

export type CallIntroductionProps = {
  onExploreSamples: () => void;
  className?: string;
};

export function renderCallIntroduction({
  onExploreSamples,
  className,
}: CallIntroductionProps) {
  return (
    <section
      className={mergeClasses(
        "flex flex-col justify-center bg-muted p-6",
        className,
      )}
      aria-label="Call introduction"
    >
      <h2 className="text-2xl leading-8 font-semibold">
        Call Northstar Freight
      </h2>
      <p className="mt-5 text-muted-foreground">
        Use your microphone to talk naturally. You can interrupt, ask about the
        load, or make a counteroffer.
      </p>
      <ol className="mt-5 space-y-2">
        <li>
          <span className="mr-2">01</span>Verify carrier
        </li>
        <li>
          <span className="mr-2">02</span>Find a load
        </li>
        <li>
          <span className="mr-2">03</span>Agree a rate
        </li>
      </ol>
      <p className="mt-5 text-xs leading-4 text-muted-foreground">
        Your transcript is saved. Audio is not recorded.
      </p>
      <Button
        variant="outline"
        size="small"
        onClick={onExploreSamples}
        className="mt-5 self-start border-0 bg-surface text-sm"
      >
        Explore sample calls
      </Button>
    </section>
  );
}
