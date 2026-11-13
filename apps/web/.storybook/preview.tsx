import { useEffect, type ReactNode } from "react";
import type { Preview } from "@storybook/react-vite";
import "@fontsource-variable/inter";
import "../app/globals.css";

function renderTheme({
  theme,
  children,
}: {
  theme: string;
  children: ReactNode;
}) {
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    return () => {
      delete document.documentElement.dataset.theme;
    };
  }, [theme]);
  return <div data-theme={theme}>{children}</div>;
}
const Theme = renderTheme;
const preview: Preview = {
  globalTypes: {
    theme: {
      description: "Color theme",
      toolbar: {
        title: "Theme",
        icon: "paintbrush",
        dynamicTitle: true,
        items: [
          { value: "light", title: "Light" },
          { value: "dark", title: "Dark" },
        ],
      },
    },
  },
  initialGlobals: { theme: "light" },
  decorators: [
    (Story, context) => (
      <Theme theme={context.globals.theme === "dark" ? "dark" : "light"}>
        <Story />
      </Theme>
    ),
  ],
  parameters: {
    layout: "centered",
    controls: { expanded: true },
    options: {
      storySort: {
        order: ["Layouts", "Navigation", "Call", "Dashboard", "UI", "Scaffold"],
      },
    },
    viewport: {
      options: {
        phone: { name: "Phone", styles: { width: "390px", height: "844px" } },
        tablet: {
          name: "Tablet",
          styles: { width: "768px", height: "1024px" },
        },
        desktop: {
          name: "FigCraft desktop",
          styles: { width: "1440px", height: "1010px" },
        },
      },
    },
  },
};
export default preview;
