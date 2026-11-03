import { CircleCheck, CircleDashed, CircleX, Loader } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { CampaignCounts, CampaignStatus } from '@/lib/campaigns/stats';

const STATUS: Record<CampaignStatus, { label: string; icon: typeof Loader; variant: 'secondary' | 'destructive' | 'outline' }> = {
  draft: { label: 'Draft', icon: CircleDashed, variant: 'outline' },
  scheduled: { label: 'Scheduled', icon: CircleDashed, variant: 'outline' },
  queued: { label: 'Queued', icon: CircleDashed, variant: 'outline' },
  running: { label: 'Sending', icon: Loader, variant: 'outline' },
  paused: { label: 'Paused', icon: CircleDashed, variant: 'outline' },
  completed: { label: 'Sent', icon: CircleCheck, variant: 'secondary' },
  cancelled: { label: 'Cancelled', icon: CircleX, variant: 'outline' },
  failed: { label: 'Stopped', icon: CircleX, variant: 'destructive' },
  interrupted: { label: 'Interrupted', icon: CircleX, variant: 'destructive' },
};

export function CampaignStatusBadge({ status }: { status: CampaignStatus }) {
  const { label, icon: Icon, variant } = STATUS[status];
  return (
    <Badge variant={variant}>
      <Icon aria-hidden />
      {label}
    </Badge>
  );
}

// Status colours from the chart palette. Each part also has a label in the legend, so colour never carries it alone.
const PARTS = [
  { key: 'seg_delivered', label: 'Delivered', color: '#0ca30c' },
  { key: 'seg_waiting', label: 'Waiting for an update', color: 'var(--muted-foreground)' },
  { key: 'seg_problem', label: 'Failed, bounced or complained', color: '#d03b3b' },
  { key: 'seg_skipped', label: 'Skipped', color: 'var(--border)' },
] as const;

/** One whole split into parts. The recipients table below it is the table view. */
export function DeliveryBar({ counts }: { counts: CampaignCounts }) {
  const parts = PARTS.map((p) => ({ ...p, value: counts[p.key] })).filter((p) => p.value > 0);
  const name = parts.map((p) => `${p.label}: ${p.value.toLocaleString('en-IN')}`).join(', ');
  if (!counts.total) return null;
  return (
    <div className="space-y-2">
      <div role="img" aria-label={`Delivery progress for ${counts.total.toLocaleString('en-IN')} recipients. ${name}`} className="flex h-2 gap-0.5">
        {parts.map((p) => (
          <div key={p.key} title={`${p.label}: ${p.value.toLocaleString('en-IN')}`} className="min-w-1 first:rounded-l-full last:rounded-r-full" style={{ flexGrow: p.value, flexBasis: 0, backgroundColor: p.color }} />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {parts.map((p) => (
          <li key={p.key} className="flex items-center gap-1.5">
            <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: p.color }} />
            {p.label}: {p.value.toLocaleString('en-IN')}
          </li>
        ))}
      </ul>
    </div>
  );
}
