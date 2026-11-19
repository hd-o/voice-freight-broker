import { AccountPanel, type AccountPanelProps } from "./account-panel";
import { AlertDialog } from "@/components/ui/alert-dialog";

export default function AccountDialog({
  onOpenChange,
  ...panel
}: AccountPanelProps & { onOpenChange: (open: boolean) => void }): React.JSX.Element {
  return (
    <AlertDialog open onOpenChange={onOpenChange}>
      <AccountPanel {...panel} />
    </AlertDialog>
  );
}
