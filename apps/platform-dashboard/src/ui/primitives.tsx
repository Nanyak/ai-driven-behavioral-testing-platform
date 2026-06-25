// Shared UI primitives (R5). Thin wrappers over the .ui-* token classes in
// styles.css so views stop re-deriving the same card/badge/empty markup.
import type { ReactNode } from "react";

export function Card({
  className = "",
  children,
  ...rest
}: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`ui-card ${className}`} {...rest}>
      {children}
    </div>
  );
}

type BadgeTone = "ok" | "bad" | "warn" | "neutral";

export function Badge({
  tone = "neutral",
  children,
  title,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`ui-badge ${tone}`} title={title}>
      {children}
    </span>
  );
}

export function EmptyState({
  icon,
  children,
}: {
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="ui-empty" role="status">
      {icon}
      <div>{children}</div>
    </div>
  );
}

export function Skeleton({
  width = "100%",
  height = 16,
  radius,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
}) {
  return (
    <span
      className="ui-skeleton"
      aria-hidden="true"
      style={{
        display: "block",
        width,
        height,
        ...(radius != null ? { borderRadius: radius } : {}),
      }}
    />
  );
}
