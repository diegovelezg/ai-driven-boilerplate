"use server";

import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase-server";

export interface AuthState {
  ok: boolean;
  message: string;
}

/** Login solo con email+password (sin signup público: el merchant lo crea Studio/CLI). */
export async function signInAction(_prev: AuthState | null, formData: FormData): Promise<AuthState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "").trim();
  if (!email || !password) return { ok: false, message: "Falta email o password." };
  let supabase;
  try {
    supabase = await createServerSupabase();
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Supabase no configurado." };
  }
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    console.error("[login] signInWithPassword:", error.status, error.message);
    return { ok: false, message: `Credenciales inválidas. (${error.message})` };
  }
  const { data, error: membersError } = await supabase
    .from("merchant_users")
    .select("store_id")
    .order("created_at", { ascending: true });
  if (membersError) {
    console.error("[login] merchant_users:", membersError.message);
    redirect(safeNext(next) ?? "/");
  }
  const memberIds = ((data ?? []) as Array<{ store_id: unknown }>)
    .map((r) => String(r.store_id ?? ""))
    .filter(Boolean);
  const storeId = memberIds[0] as string | undefined;
  const dest = pickSafeNext(next, memberIds) ?? (storeId ? `/?store=${storeId}` : "/");
  redirect(dest);
}

export async function signOutAction(): Promise<void> {
  const supabase = await createServerSupabase();
  await supabase.auth.signOut();
  redirect("/login");
}

/** `next` seguro contra open-redirect: path absoluto same-origin sin
 *  backslash ni slash codificado (`/%2f`, `/\evil`, `//evil`). */
function safeNext(next: string): string | null {
  if (!next.startsWith("/") || next.startsWith("//")) return null;
  if (next.includes("\\")) return null;
  if (/%2f/i.test(next)) return null;
  if (!/^\/[^/\\]/.test(next) && next !== "/") return null;
  return next;
}

/** `next` solo si apunta a una tienda del usuario (o no pide tienda). */
function pickSafeNext(next: string, memberIds: string[]): string | null {
  const safe = safeNext(next);
  if (!safe) return null;
  let store: string | null = null;
  try {
    store = new URL(safe, "http://x").searchParams.get("store");
  } catch {
    return null;
  }
  if (store && !memberIds.includes(store)) return null;
  return safe;
}
