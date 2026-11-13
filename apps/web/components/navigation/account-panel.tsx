import {
  renderAlertDialogAction as AlertDialogAction,
  renderAlertDialogCancel as AlertDialogCancel,
  renderAlertDialogContent as AlertDialogContent,
  renderAlertDialogDescription as AlertDialogDescription,
  renderAlertDialogFooter as AlertDialogFooter,
  renderAlertDialogHeader as AlertDialogHeader,
  renderAlertDialogTitle as AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { Identity } from "@voice-freight/contracts/business";

export type AccountPanelProps = {
  identities: readonly Identity[];
  pending: boolean;
  progress?: string;
  error?: string;
  onSignIn: (id: string) => void;
};

export function renderAccountPanel({
  identities,
  pending,
  progress,
  error,
  onSignIn,
}: AccountPanelProps) {
  return (
    <AlertDialogContent className="max-w-xl">
      <AlertDialogHeader>
        <AlertDialogTitle>Local sign in</AlertDialogTitle>
        <AlertDialogDescription>
          Choose a development account. Local sessions last eight hours.
        </AlertDialogDescription>
      </AlertDialogHeader>
      {error && <p role="alert">{error}</p>}
      {pending && <p role="status">{progress ?? "Loading account…"}</p>}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        {identities.map((identity) => (
          <AlertDialogAction
            key={identity.id}
            disabled={pending}
            onClick={() => onSignIn(identity.id)}
          >
            {identity.name}
          </AlertDialogAction>
        ))}
      </div>
      <AlertDialogFooter>
        <AlertDialogCancel disabled={pending}>Close</AlertDialogCancel>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
}
