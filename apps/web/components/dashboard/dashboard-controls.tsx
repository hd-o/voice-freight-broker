import { renderButton as Button } from "@/components/ui/button";

export type DashboardControlsProps = {
  administrator: boolean;
  accountName: string;
  restocking?: boolean;
  feedback?: string;
  error?: boolean;
  onRestock: () => void;
};

export function renderDashboardControls({
  administrator,
  accountName,
  restocking,
  feedback,
  error,
  onRestock,
}: DashboardControlsProps) {
  return (
    <section aria-label="Dashboard data" className="space-y-3">
      <div className="flex flex-wrap items-center gap-4">
        <span className="text-sm text-muted-foreground">
          {accountName} · {administrator ? "Administrator" : "Reviewer"}
        </span>
        {administrator && (
          <Button variant="outline" disabled={restocking} onClick={onRestock}>
            {restocking ? "Restocking…" : "Restock inventory"}
          </Button>
        )}
      </div>
      {feedback && <p role={error ? "alert" : "status"}>{feedback}</p>}
    </section>
  );
}
