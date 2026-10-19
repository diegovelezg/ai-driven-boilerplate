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
    <div className="relative flex min-h-full w-full items-center justify-center overflow-hidden bg-gradient-to-br from-primary/[0.06] via-background to-background p-6">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 -right-24 size-96 rounded-full bg-primary/10 blur-3xl"
      />
      <div className="relative w-full max-w-sm">
        <LoginForm next={next} />
      </div>
    </div>
  );
}
