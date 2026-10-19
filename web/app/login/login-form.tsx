"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signInAction } from "@/lib/auth-actions";

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(signInAction, null);
  return (
    <form action={action} className="w-full max-w-sm">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">AI Retention Engine</CardTitle>
          <CardDescription>Ingresa con tu cuenta de merchant.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <input type="hidden" name="next" value={next} />
          <div className="grid gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="username" required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="password">Password</Label>
            <Input id="password" name="password" type="password" autoComplete="current-password" required />
          </div>
          {state && !state.ok && <p className="text-xs text-destructive">{state.message}</p>}
          <Button type="submit" disabled={pending}>
            {pending ? "Ingresando…" : "Ingresar"}
          </Button>
        </CardContent>
      </Card>
    </form>
  );
}
