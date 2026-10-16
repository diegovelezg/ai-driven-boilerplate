import { SettingsForm } from "@/components/settings-form";
import { readConnections } from "@/lib/store";

export const instant = false;

export default async function SettingsPage() {
  const defaults = await readConnections();
  return (
    <div className="flex w-full flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
      </header>
      <SettingsForm defaults={defaults} />
    </div>
  );
}
