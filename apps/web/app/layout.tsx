import type { ReactNode } from "react";
import { Providers } from "@/components/providers";
import { SharedApplicationLayout } from "@/components/layouts/shared-application-layout";

export const metadata = {
  title: "Voice Freight Broker",
  icons: { icon: "/favicon.svg" },
};

export default function Layout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <html lang="en">
      <body>
        <Providers>
          <SharedApplicationLayout>{children}</SharedApplicationLayout>
        </Providers>
      </body>
    </html>
  );
}
