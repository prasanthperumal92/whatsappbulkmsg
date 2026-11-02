'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchJson } from '@/lib/client/fetch-json';

type Member = { email: string; addedBy: string | null; addedAt: string };

export function TeamSection() {
  const client = useQueryClient();
  const [email, setEmail] = useState('');
  const team = useQuery({ queryKey: ['team'], queryFn: () => fetchJson<{ items: Member[] }>('/api/team') });
  const refresh = () => client.invalidateQueries({ queryKey: ['team'] });

  const add = useMutation({
    mutationFn: (value: string) => fetchJson('/api/team', { method: 'POST', body: JSON.stringify({ email: value }) }),
    onSuccess: () => {
      setEmail('');
      return refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (value: string) => fetchJson('/api/team', { method: 'DELETE', body: JSON.stringify({ email: value }) }),
    onSuccess: refresh,
  });
  const error = add.error ?? remove.error ?? team.error;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Team</h2>
        </CardTitle>
        <CardDescription>Only these emails can sign in. Everyone on the team has the same access.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            remove.reset();
            add.mutate(email);
          }}
        >
          <div className="grid flex-1 gap-1.5">
            <Label htmlFor="team-email">Email to add</Label>
            <Input id="team-email" type="email" required placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <Button type="submit" disabled={add.isPending}>
            {add.isPending ? 'Adding…' : 'Add'}
          </Button>
        </form>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}

        {team.isPending ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <ul className="divide-y rounded-lg border" aria-label="Team members">
            {team.data?.items.map((m) => (
              <li key={m.email} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="truncate">{m.email}</span>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="sm">
                      Remove
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove {m.email}?</AlertDialogTitle>
                      <AlertDialogDescription>They lose access straight away, including any session they have open.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => {
                          add.reset();
                          remove.mutate(m.email);
                        }}
                      >
                        Remove
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
