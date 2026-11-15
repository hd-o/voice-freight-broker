import { useEffect, type ReactNode } from "react";
import type { Preview } from "@storybook/react-vite";
import "@fontsource-variable/inter";
import "../app/globals.css";

function renderTheme({ theme, children }: { theme: "light" | "dark"; children: ReactNode }): React.JSX.Element {
  useEffect((): (() => void) => {
    document.documentElement.dataset.theme = theme;

    return (): void => {
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
    (Story, context): React.JSX.Element => (
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
        xs: { name: "xs (390px)", styles: { width: "390px", height: "844px" } },
        sm: {
          name: "sm (640px)",
          styles: { width: "640px", height: "1024px" },
        },
        md: {
          name: "md (768px)",
          styles: { width: "768px", height: "1024px" },
        },
        lg: {
          name: "lg (1024px)",
          styles: { width: "1024px", height: "1024px" },
        },
        xl: {
          name: "xl (1280px)",
          styles: { width: "1280px", height: "1024px" },
        },
        "2xl": {
          name: "2xl (1536px)",
          styles: { width: "1536px", height: "1024px" },
        },
      },
    },
  },
};

export default preview;
