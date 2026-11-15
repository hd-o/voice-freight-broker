import { mergeClasses } from "@/lib/classes";

export type DemoCarrier = {
  name: string;
  mcNumber: string;
  preferredRoute?: string;
  preferredEquipment?: string;
  verificationNote?: string;
};

export type CallerBriefingProps = {
  carriers: readonly DemoCarrier[];
  className?: string;
};

export function CallerBriefing({ carriers, className }: CallerBriefingProps): React.JSX.Element {
  return (
    <section
      className={mergeClasses("rounded-[10px] border border-border bg-surface p-6", className)}
      aria-label="Your caller briefing"
    >
      <span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-xs leading-4">Demo verification</span>
      <h2 className="mt-4 text-xl leading-7 font-semibold">Your caller briefing</h2>
      <p className="mt-4 text-muted-foreground">
        You are a carrier calling Northstar Freight, a fictional brokerage. Ask about available loads and negotiate
        rates. Pick a demo carrier below and share its MC number. If eligible, use its preferred route and equipment to
        search for a load. You can choose a different carrier for each call.
      </p>
      <h3 className="mt-4 text-xs leading-4 text-muted-foreground">Demo carriers</h3>
      <ul className="mt-2 space-y-2">
        {carriers.map((carrier): React.JSX.Element => (
          <li key={carrier.mcNumber} className="rounded-lg bg-muted px-3 py-2.5">
            <p>{carrier.name}</p>
            <p className="mt-0.5 text-xs leading-4 text-muted-foreground">MC {carrier.mcNumber}</p>
            {carrier.preferredRoute && carrier.preferredEquipment && (
              <dl className="mt-2 text-xs leading-4">
                <div>
                  <dt className="inline text-muted-foreground">Preferred route: </dt>
                  <dd className="inline">{carrier.preferredRoute}</dd>
                </div>
                <div className="mt-1">
                  <dt className="inline text-muted-foreground">Equipment: </dt>
                  <dd className="inline">{carrier.preferredEquipment}</dd>
                </div>
              </dl>
            )}
            {carrier.verificationNote && (
              <p className="mt-2 text-xs leading-4 text-muted-foreground">{carrier.verificationNote}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
