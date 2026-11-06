"use client";

import { useActionState } from "react";
import { Cat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppCard } from "@/components/app-card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signInAction } from "@/lib/auth-actions";

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(signInAction, null);
  return (
    <form action={action} className="w-full max-w-sm">
      <AppCard
        title={
          <span className="flex flex-col gap-2">
            <span className="mb-1 flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Cat className="size-5" strokeWidth={2} />
            </span>
            Entra a tu motor de retención
          </span>
        }
        description="Tu operación de retención, lista para hoy."
        footer={
          <Button type="submit" disabled={pending} className="w-full">
            {pending ? "Ingresando…" : "Ingresar"}
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
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
        </div>
      </AppCard>
    </form>
  );
}
