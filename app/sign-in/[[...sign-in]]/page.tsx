import { SignIn } from '@clerk/nextjs';

export default function SignInPage() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <SignIn withSignUp={false} />
    </main>
  );
}
