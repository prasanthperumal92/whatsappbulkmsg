import type { ReactNode } from 'react';

// Stand-in for @clerk/nextjs in local browser tests. See next.config.ts.
export const ClerkProvider = ({ children }: { children: ReactNode; dynamic?: boolean; signInUrl?: string }) => <>{children}</>;
export const SignIn = (_: { withSignUp?: boolean }) => <div data-testid="fake-sign-in">Sign in</div>;
export const SignOutButton = ({ children }: { children: ReactNode; redirectUrl?: string }) => <>{children}</>;
export const UserButton = () => <div data-testid="fake-user-button" aria-label="User menu" className="size-7 rounded-full bg-muted" />;
