import type { ReactNode } from 'react';

export const metadata = {
  title: 'Email Gateway',
  description: 'Central email system — priority-aware rationing of one Resend free-tier quota.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          background: '#0b1021',
          color: '#e2e8f0',
          fontFamily: "'Segoe UI', Tahoma, system-ui, sans-serif",
        }}
      >
        {children}
      </body>
    </html>
  );
}
