'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { CircleCheck } from 'lucide-react';
import Link from 'next/link';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { fetchJson } from '@/lib/client/fetch-json';
import { formatCount, type CommitResult, type ImportInfo } from './types';

export function StepResult({ result, onStartOver }: { result: CommitResult; onStartOver: () => void }) {
  const id = result.import_id;
  const info = useQuery({ queryKey: ['import', id], queryFn: () => fetchJson<ImportInfo>(`/api/imports/${id}`), refetchInterval: 15_000 });
  const undo = useMutation({
    mutationFn: () => fetchJson<{ removed_rows: number; restored_rows: number }>(`/api/imports/${id}/undo`, { method: 'POST', body: '{}' }),
    onSettled: () => info.refetch(),
  });
  const rejected = Object.values(result.summary.invalid).reduce((a, b) => a + b, 0);
  const blocked = info.data?.undo_blocked_reason ?? null;

  if (undo.isSuccess) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Import undone</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm">
            {formatCount(undo.data.removed_rows)} added contacts removed · {formatCount(undo.data.restored_rows)} updated contacts restored. Any opt-outs received since the import stay in place.
          </p>
          <Button onClick={onStartOver}>Import another file</Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="flex items-center gap-2">
            <CircleCheck className="size-4 text-emerald-600" aria-hidden />
            Step 4: Import complete
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm" data-testid="import-result">
          {formatCount(result.new_rows)} added · {formatCount(result.updated_rows)} updated · {formatCount(rejected)} rejected
        </p>
        <div className="flex flex-wrap gap-2">
          <Link className={buttonVariants({ variant: 'default' })} href={`/contacts?import=${id}`}>View imported contacts</Link>
          <Link className={buttonVariants({ variant: 'outline' })} href={`/campaigns?import=${id}&channel=whatsapp`}>Start WhatsApp campaign</Link>
          <Link className={buttonVariants({ variant: 'outline' })} href={`/campaigns?import=${id}&channel=email`}>Start email campaign</Link>
        </div>
        <div className="space-y-2 border-t pt-4">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" disabled={!!blocked || !info.data || undo.isPending}>Undo this import</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Undo this import?</AlertDialogTitle>
                <AlertDialogDescription>
                  Added contacts are removed and updated contacts go back to how they were. Anyone who has opted out since stays opted out.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => undo.mutate()}>Undo import</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <p className="text-xs text-muted-foreground">{blocked ?? 'Available until someone makes another change to contacts.'}</p>
          {undo.error && (
            <Alert variant="destructive">
              <AlertDescription>{undo.error.message}</AlertDescription>
            </Alert>
          )}
        </div>
        <Button variant="ghost" onClick={onStartOver}>Import another file</Button>
      </CardContent>
    </Card>
  );
}
