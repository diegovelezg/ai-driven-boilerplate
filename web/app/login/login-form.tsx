"use client";

import { useActionState, useEffect, useState } from "react";
import { Cat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppCard } from "@/components/app-card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signInAction } from "@/lib/auth-actions";
import { toastFormError, useInvalidFields } from "@/components/ui/form-feedback";

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(signInAction, null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { invalid, mark, clear } = useInvalidFields<"email" | "password">();

  const ready = email.trim().length > 0 && password.length > 0;

  // Error del server (credenciales, etc.): borde + toast, sin texto inline.
  useEffect(() => {
    if (!state || state.ok) return;
    mark(["email", "password"]);
    toastFormError("No se pudo ingresar", state.message);
  }, [state, mark]);

  return (
    <form action={action} noValidate className="w-full max-w-sm">
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
          <Button type="submit" disabled={pending || !ready} className="w-full" title={!ready ? "Completa email y password" : undefined}>
            {pending ? "Ingresando…" : "Ingresar"}
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          <input type="hidden" name="next" value={next} />
          <div className="grid gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                clear("email");
              }}
              aria-invalid={invalid.has("email")}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                clear("password");
              }}
              aria-invalid={invalid.has("password")}
            />
          </div>
        </div>
      </AppCard>
    </form>
  );
}
