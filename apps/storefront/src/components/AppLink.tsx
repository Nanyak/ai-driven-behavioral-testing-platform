import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from "react";

type AppLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  children: ReactNode;
  to: string;
  onNavigate: (path: string) => void;
};

export function AppLink({ children, className, to, onNavigate, ...anchorProps }: AppLinkProps) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }

    event.preventDefault();
    onNavigate(to);
  }

  return (
    <a {...anchorProps} className={className} href={to} onClick={handleClick}>
      {children}
    </a>
  );
}
