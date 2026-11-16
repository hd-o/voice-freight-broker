import type { ComponentProps } from "react";

export default function Link(props: ComponentProps<"a">): React.JSX.Element {
  return <a {...props} />;
}
