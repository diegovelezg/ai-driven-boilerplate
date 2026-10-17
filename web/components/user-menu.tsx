"use client";

import { useEffect, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { signOutAction } from "@/lib/auth-actions";
import { createBrowserSupabase } from "@/lib/supabase-browser";

/** Avatar del merchant (inicial) + logout. Silencioso si no hay sesión. */
export function UserMenu() {
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let client;
    try {
      client = createBrowserSupabase();
    } catch {
      return; // Sin env pública: silencioso, sin avatar.
    }
    client
      .auth.getUser()
      .then(({ data }) => {
        if (alive) setEmail(data.user?.email ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  if (!email) return null;
  const initial = (email.trim()[0] ?? "?").toUpperCase();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={`Cuenta ${email}`}
            className="flex size-7 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
          >
            {initial}
          </button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled>{email}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => void signOutAction()}>
          Cerrar sesión
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
