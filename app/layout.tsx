import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import './globals.css';

export const metadata: Metadata = {
  title: 'Bulk Messenger',
  description: 'WhatsApp and email marketing for the team',
  robots: { index: false, follow: false },
};

// Every page depends on the session; nothing here can be prerendered.
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="font-sans antialiased">
        <ClerkProvider dynamic signInUrl="/sign-in">
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}
