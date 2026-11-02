// §9: the only routes reachable with no session. Each protects itself instead:
// webhooks by signature, crons by CRON_SECRET, unsubscribe by a signed token.
export const PUBLIC_ROUTE_PATTERNS = ['/api/webhooks(.*)', '/api/cron(.*)', '/u/(.*)', '/sign-in(.*)'];

export function isExemptApiPath(path: string) {
  return path.startsWith('/api/webhooks/') || path.startsWith('/api/cron/');
}
