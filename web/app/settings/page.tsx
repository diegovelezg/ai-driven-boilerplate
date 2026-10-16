import { SettingsForm } from "@/components/settings-form";
import { TenantProfileForm } from "@/components/tenant-profile-form";
import { resolveStoreId } from "@/lib/customers-db";
import { readConnections } from "@/lib/store";
import { getProfileSignals, getStoreProfile, suggestArchetype } from "@/lib/store-profiles";
import { isSupabaseConfigured } from "@/lib/supabase";

export const instant = false;

export default async function SettingsPage() {
  const defaults = await readConnections();
  const storeId =
    isSupabaseConfigured() && defaults.medusaUrl
      ? await resolveStoreId(defaults.medusaUrl).catch(() => null)
      : null;
  const [profile, signals] = storeId
    ? await Promise.all([
        getStoreProfile(storeId).catch(() => null),
        getProfileSignals(storeId).catch(() => null),
      ])
    : [null, null];
  const suggestion = suggestArchetype(signals);
  return (
    <div className="flex w-full flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
      </header>
      <SettingsForm defaults={defaults} />
      <TenantProfileForm storeId={storeId} profile={profile} suggestion={suggestion} />
    </div>
  );
}
