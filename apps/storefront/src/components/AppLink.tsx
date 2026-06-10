import type { MouseEvent, ReactNode } from "react";

type AppLinkProps = {
  children: ReactNode;
  className?: string;
  to: string;
  onNavigate: (path: string) => void;
};

export function AppLink({ children, className, to, onNavigate }: AppLinkProps) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }

    event.preventDefault();
    onNavigate(to);
  }

  return (
    <a className={className} href={to} onClick={handleClick}>
      {children}
    </a>
  );
}
