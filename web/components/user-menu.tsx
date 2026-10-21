"use client";

import { useEffect, useState, useTransition } from "react";
import { LogOut } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { signOutAction } from "@/lib/auth-actions";
import { toast } from "@/components/ui/toast";
import { createBrowserSupabase } from "@/lib/supabase-browser";

/**
 * Avatar del merchant + dropdown de cuenta.
 * - `initialEmail` viene del servidor (layout dashboard): pinta email + avatar
 *   en el primer paint sin esperar al fetch cliente.
 * - Se suscribe a cambios de sesión para no quedarse stale tras login/logout.
 * - Silencioso (skeleton → nada) si no hay sesión.
 */
export function UserMenu({ initialEmail = null }: { initialEmail?: string | null }) {
  const [email, setEmail] = useState<string | null>(initialEmail);
  const [loaded, setLoaded] = useState(initialEmail != null);
  const [pending, startSignOut] = useTransition();

  useEffect(() => {
    let alive = true;
    let unsubscribe: (() => void) | null = null;
    (async () => {
      try {
        const client = createBrowserSupabase();
        const { data } = await client.auth.getUser();
        if (alive) {
          setEmail(data.user?.email ?? null);
          setLoaded(true);
        }
        const { data: listener } = client.auth.onAuthStateChange((_event, session) => {
          if (alive) {
            setEmail(session?.user?.email ?? null);
            setLoaded(true);
          }
        });
        unsubscribe = () => listener.subscription.unsubscribe();
      } catch {
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, []);

  if (!loaded) {
    return (
      <span
        aria-hidden
        className="size-8 animate-pulse rounded-full bg-muted"
      />
    );
  }
  if (!email) return null;

  const initial = (email.trim()[0] ?? "?").toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={`Cuenta ${email}`}
            title={email}
            className="flex size-8 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground ring-offset-background transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {initial}
          </button>
        }
      />
      <DropdownMenuContent align="end" sideOffset={8} className="w-64">
        <div className="flex items-center gap-2.5 px-2 py-2">
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
          >
            {initial}
          </span>
          <span className="min-w-0">
            <span className="block text-xs text-muted-foreground">
              Sesión iniciada como
            </span>
            <span
              className="block truncate text-sm font-medium"
              title={email}
            >
              {email}
            </span>
          </span>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={pending}
          onClick={(e) => {
            e.preventDefault();
            startSignOut(async () => {
              try {
                await signOutAction();
              } catch (err) {
                toast.add({
                  title: "No se pudo cerrar sesión",
                  description: err instanceof Error ? err.message : "Error inesperado.",
                  type: "error",
                });
              }
            });
          }}
        >
          <LogOut aria-hidden />
          {pending ? "Cerrando sesión…" : "Cerrar sesión"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
