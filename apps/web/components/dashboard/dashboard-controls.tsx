import { renderButton as Button } from "@/components/ui/button";

export type DashboardControlsProps = {
  restocking?: boolean;
  feedback?: string;
  error?: boolean;
  onRestock: () => void;
};

export function renderDashboardControls({
  restocking,
  feedback,
  error,
  onRestock,
}: DashboardControlsProps) {
  return (
    <section aria-label="Dashboard data" className="space-y-3">
      <Button variant="outline" disabled={restocking} onClick={onRestock}>
        {restocking ? "Restocking…" : "Restock inventory"}
      </Button>
      {feedback && <p role={error ? "alert" : "status"}>{feedback}</p>}
    </section>
  );
}
