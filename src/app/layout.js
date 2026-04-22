import './globals.css';

export const metadata = {
  title: 'RushDesk',
  description: 'AI-powered order and reservation management for local businesses',
  manifest: '/manifest.json',
  themeColor: '#ffffff',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
