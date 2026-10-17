import { redirect } from "next/navigation";
import { createServerSupabase, isUserAuthConfigured } from "@/lib/supabase-server";
import { LoginForm } from "./login-form";

export const instant = false;

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const sp = await searchParams;
  const next = sp.next ?? "";
  if (isUserAuthConfigured()) {
    const supabase = await createServerSupabase();
    const { data } = await supabase.auth.getUser();
    if (data.user) redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/");
  }
  return (
    <div className="flex min-h-full w-full items-center justify-center p-6">
      <LoginForm next={next} />
    </div>
  );
}
