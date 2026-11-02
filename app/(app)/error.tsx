'use client';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

export default function AppError({ reset }: { error: Error; reset: () => void }) {
  return (
    <Alert variant="destructive" className="max-w-xl">
      <AlertTitle>This page couldn&apos;t load</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>Your data hasn&apos;t changed. Try again, and if it keeps happening, let the team know.</p>
        <Button variant="outline" size="sm" onClick={reset}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}
