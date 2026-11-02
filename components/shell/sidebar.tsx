'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { NAV_ITEMS } from './nav';

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="border-b bg-sidebar text-sidebar-foreground md:sticky md:top-0 md:h-svh md:w-56 md:shrink-0 md:border-r md:border-b-0">
      <div className="flex h-14 items-center px-4 font-semibold">Bulk Messenger</div>
      <nav aria-label="Main" className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-visible">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap hover:bg-sidebar-accent',
                active && 'bg-sidebar-accent font-medium',
              )}
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
