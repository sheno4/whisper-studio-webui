import type { ReactNode } from 'react';

interface AppFooterProps {
  context: string;
  title: string;
  message: string;
  timestamp: string;
}

function FooterItem({ children }: { children: ReactNode }): React.JSX.Element {
  return <span>{children}</span>;
}

function AppFooter({ context, title, message, timestamp }: AppFooterProps): React.JSX.Element {
  return (
    <footer className="app-footer glass-chrome">
      <FooterItem><strong>{context}</strong> · {title}</FooterItem>
      <FooterItem>{message}</FooterItem>
      <FooterItem>{timestamp}</FooterItem>
    </footer>
  );
}

export default AppFooter;
