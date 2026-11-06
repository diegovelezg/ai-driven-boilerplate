import { PageHeader } from "@/components/page-header";

export const instant = false;

export default function DashboardPage() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 p-6 md:p-8">
      <PageHeader eyebrow="Resumen" title="Dashboard" />
    </div>
  );
}
