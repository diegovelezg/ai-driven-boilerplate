"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Merge } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppCard } from "@/components/app-card";
import { toast } from "@/components/ui/toast";
import { mergeContactsAction } from "@/lib/crm-actions";
import type { DuplicateGroup } from "@/lib/contact-duplicates";
import { ArchivedBadge } from "@/components/badges";
import { CompanyPrincipalBadge } from "@/components/company-badges";
import { EntityEmpty } from "@/components/entity-list";

function displayName(r: DuplicateGroup["rows"][number]): string {
  return [r.first_name, r.last_name].filter(Boolean).join(" ") || "—";
}

export function DuplicatesList({ groups }: { groups: DuplicateGroup[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [merging, setMerging] = useState<string | null>(null);

  const merge = (group: DuplicateGroup, survivorId: string) => {
    const losers = group.ids.filter((id) => id !== survivorId);
    if (losers.length === 0) return;
    setMerging(group.ids[0]);
    startTransition(async () => {
      try {
        const r = await mergeContactsAction({ survivorId, loserIds: losers });
        toast.add({
          title: r.ok ? "Contactos fusionados" : "No se pudo fusionar",
          description: r.message,
          type: r.ok ? "success" : "error",
        });
        if (r.ok) router.refresh();
      } finally {
        setMerging(null);
      }
    });
  };

  if (groups.length === 0) {
    return (
      <EntityEmpty
        filtered={false}
        emptyTitle="Sin duplicados"
        emptyHint="No hay grupos por revisar: emails y teléfonos están limpios."
      />
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground tabular-nums">
        {groups.length} grupo{groups.length === 1 ? "" : "s"} por revisar
      </p>
      {groups.map((g) => (
        <GroupCard key={g.ids[0]} group={g} merging={merging === g.ids[0] || pending} onMerge={merge} />
      ))}
    </div>
  );
}

function GroupCard({
  group,
  merging,
  onMerge,
}: {
  group: DuplicateGroup;
  merging: boolean;
  onMerge: (group: DuplicateGroup, survivorId: string) => void;
}) {
  const [survivor, setSurvivor] = useState(group.rows[0].id);
  return (
    <AppCard
      title={
        group.reasons.includes("email") && group.reasons.includes("phone")
          ? "Mismo email y teléfono"
          : group.reasons.includes("email")
            ? "Mismo email"
            : "Mismo teléfono"
      }
      contentClassName="flex flex-col gap-3"
    >
      <ul className="flex flex-col gap-2">
        {group.rows.map((r) => (
          <li key={r.id}>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-muted/60">
              <input
                type="radio"
                name={`survivor-${group.ids[0]}`}
                checked={survivor === r.id}
                onChange={() => setSurvivor(r.id)}
                className="mt-1"
                aria-label={`Queda ${displayName(r)}`}
              />
              <span className="flex flex-1 flex-wrap items-baseline gap-x-2 text-[13px]">
                <strong>{displayName(r)}</strong>
                {r.job_title && <span className="text-muted-foreground">{r.job_title}</span>}
                {r.company_name && <span className="text-muted-foreground">· {r.company_name}</span>}
                {r.is_primary && <CompanyPrincipalBadge isPrimary />}
                {r.archived && <ArchivedBadge />}
                <span className="w-full text-xs text-muted-foreground tabular-nums">
                  {[r.email, r.phone].filter(Boolean).join(" · ") || "sin canal"}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div>
        <Button size="sm" disabled={merging} onClick={() => onMerge(group, survivor)}>
          <Merge aria-hidden />
          {merging ? "Fusionando…" : `Fusionar en el elegido (${group.rows.length - 1} se eliminan)`}
        </Button>
      </div>
    </AppCard>
  );
}
