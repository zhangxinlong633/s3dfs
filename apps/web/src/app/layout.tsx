import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 's3dfs console',
  description: 'Packed-block S3 object store',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
