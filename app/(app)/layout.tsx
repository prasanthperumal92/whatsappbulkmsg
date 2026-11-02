import { redirect } from 'next/navigation';
import { Banners } from '@/components/shell/banners';
import { Providers } from '@/components/shell/providers';
import { Sidebar } from '@/components/shell/sidebar';
import { UserMenu } from '@/components/shell/user-menu';
import { getSessionState } from '@/lib/auth/session';
import { getDb } from '@/lib/db';
import { getAppStatus } from '@/lib/status';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const db = getDb();
  const session = await getSessionState(db);
  if (session.state === 'anonymous') redirect('/sign-in');
  if (session.state === 'forbidden') redirect('/not-allowed');
  const status = await getAppStatus(db);

  return (
    <Providers>
      <div className="flex min-h-svh flex-col md:flex-row">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 items-center justify-end gap-3 border-b px-4 md:px-6">
            <span className="truncate text-sm text-muted-foreground">{session.user.email}</span>
            <UserMenu />
          </header>
          <Banners initial={status} />
          <main className="flex-1 p-4 md:p-6">{children}</main>
        </div>
      </div>
    </Providers>
  );
}
