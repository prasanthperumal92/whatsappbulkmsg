import { SignOutButton } from '@clerk/nextjs';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function NotAllowedPage() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>
            <h1>You don&apos;t have access</h1>
          </CardTitle>
          <CardDescription>This account isn&apos;t on the team allowlist. Ask a team member to add your email in Settings.</CardDescription>
        </CardHeader>
        <CardContent>
          <SignOutButton redirectUrl="/sign-in">
            <Button variant="outline">Sign out</Button>
          </SignOutButton>
        </CardContent>
      </Card>
    </main>
  );
}
