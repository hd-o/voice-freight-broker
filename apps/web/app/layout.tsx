import type { ReactNode } from "react";
import { Providers } from "@/components/providers";

export const metadata = {
  title: "Voice Freight Broker",
  icons: { icon: "/favicon.svg" },
};

export default function Layout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
