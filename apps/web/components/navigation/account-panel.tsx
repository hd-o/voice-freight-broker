import { renderButton as Button } from "@/components/ui/button";
import type { Identity } from "@voice-freight/contracts/business";

export type AccountPanelProps = {
  identities: readonly Identity[];
  pending: boolean;
  progress?: string;
  error?: string;
  onSignIn: (id: string) => void;
  onClose: () => void;
};

export function renderAccountPanel({
  identities,
  pending,
  progress,
  error,
  onSignIn,
  onClose,
}: AccountPanelProps) {
  return (
    <section
      aria-label="Local sign in"
      className="space-y-4 rounded-lg border border-border bg-surface p-6"
    >
      <h2 className="text-xl font-semibold">Local sign in</h2>
      <p className="text-sm text-muted-foreground">
        Choose a development account. Local sessions last eight hours.
      </p>
      {error && <p role="alert">{error}</p>}
      {pending && <p role="status">{progress ?? "Loading account…"}</p>}
      <div className="flex flex-wrap gap-3">
        {identities.map((identity) => (
          <Button
            key={identity.id}
            disabled={pending}
            onClick={() => onSignIn(identity.id)}
          >
            {identity.name}
          </Button>
        ))}
        <Button variant="outline" disabled={pending} onClick={onClose}>
          Close
        </Button>
      </div>
    </section>
  );
}
