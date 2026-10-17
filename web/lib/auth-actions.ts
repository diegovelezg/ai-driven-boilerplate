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
  if (error) return { ok: false, message: "Credenciales inválidas." };
  if (next.startsWith("/") && !next.startsWith("//")) redirect(next);
  const { data } = await supabase.from("merchant_users").select("store_id").limit(1).maybeSingle();
  const storeId = data?.store_id as string | undefined;
  redirect(storeId ? `/?store=${storeId}` : "/");
}

export async function signOutAction(): Promise<void> {
  const supabase = await createServerSupabase();
  await supabase.auth.signOut();
  redirect("/login");
}
