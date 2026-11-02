import { Activity, FileText, Megaphone, Settings, Upload, Users, type LucideIcon } from 'lucide-react';

// §5.1, in the spec's order.
export const NAV_ITEMS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: '/contacts', label: 'Contacts', icon: Users },
  { href: '/import', label: 'Import', icon: Upload },
  { href: '/templates', label: 'Templates', icon: FileText },
  { href: '/campaigns', label: 'Campaigns', icon: Megaphone },
  { href: '/activity', label: 'Activity', icon: Activity },
  { href: '/settings', label: 'Settings', icon: Settings },
];
