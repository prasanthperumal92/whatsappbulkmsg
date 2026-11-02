'use client';

import { useQuery } from '@tanstack/react-query';
import { Info, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { fetchJson } from '@/lib/client/fetch-json';
import type { AppStatus } from '@/lib/status';
import { cn } from '@/lib/utils';

export function Banners({ initial }: { initial: AppStatus }) {
  const { data } = useQuery({
    queryKey: ['status'],
    queryFn: () => fetchJson<AppStatus>('/api/status'),
    initialData: initial,
    refetchInterval: 30_000,
  });
  if (!data.banners.length) return null;
  return (
    <div role="status" className="divide-y border-b">
      {data.banners.map(({ id, tone, text, href, linkText }) => (
        <div
          key={id}
          data-banner={id}
          className={cn(
            'flex items-center gap-2 px-4 py-2 text-sm md:px-6',
            tone === 'warning' ? 'bg-amber-50 text-amber-950' : 'bg-sky-50 text-sky-950',
          )}
        >
          {tone === 'warning' ? <TriangleAlert className="size-4 shrink-0" aria-hidden /> : <Info className="size-4 shrink-0" aria-hidden />}
          <span>{text}</span>
          {href && (
            <Link href={href} className="ml-auto shrink-0 font-medium underline underline-offset-2">
              {linkText}
            </Link>
          )}
        </div>
      ))}
    </div>
  );
}
