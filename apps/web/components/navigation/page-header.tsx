import type { ReactNode } from "react";

export type PageHeaderProps = {
  title: string;
  subtitle?: string;
  children?: ReactNode;
};

export function renderPageHeader({
  title,
  subtitle,
  children,
}: PageHeaderProps) {
  return (
    <header className="flex min-w-0 flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[30px] leading-9 font-semibold tracking-[-0.75px] wrap-anywhere">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-2 text-sm leading-5 text-muted-foreground wrap-anywhere">
            {subtitle}
          </p>
        )}
      </div>
      {children && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {children}
        </div>
      )}
    </header>
  );
}
