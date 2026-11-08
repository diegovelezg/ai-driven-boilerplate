"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Save } from "lucide-react";
import { AppCard } from "@/components/app-card";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SectionHeading } from "@/components/section-heading";
import { MEMBER_ROLES, MEMBER_ROLE_LABELS, type MemberRole } from "@/lib/roles";
import { updateMemberRoleAction } from "@/lib/members-actions";
import { toastFormError } from "@/components/ui/form-feedback";
import type { StoreMember } from "@/lib/members";

function MemberRow({
  member,
  storeId,
  canEdit,
  isSelf,
}: {
  member: StoreMember;
  storeId: string | null;
  canEdit: boolean;
  isSelf: boolean;
}) {
  const [role, setRole] = useState<MemberRole>(member.role);
  const [pending, start] = useTransition();
  const router = useRouter();

  return (
    <tr className="border-b last:border-0">
      <td className="px-4 py-2 text-sm">
        {member.email ?? `${member.user_id.slice(0, 8)}…`}
        {isSelf && <span className="ml-2 text-xs text-muted-foreground">(tú)</span>}
      </td>
      <td className="px-4 py-2 text-xs">
        {canEdit ? (
          <Select
            value={role}
            onValueChange={(v) => {
              if (v) setRole(v as MemberRole);
            }}
            items={Object.fromEntries(
              MEMBER_ROLES.map((r) => [r, MEMBER_ROLE_LABELS[r]]),
            )}
            disabled={pending}
          >
            <SelectTrigger
              size="sm"
              aria-label={`Rol de ${member.email ?? member.user_id}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MEMBER_ROLES.map((r) => (
                <SelectItem key={r} value={r}>
                  {MEMBER_ROLE_LABELS[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          MEMBER_ROLE_LABELS[member.role]
        )}
      </td>
      <td className="px-4 py-2 text-right">
        {canEdit && role !== member.role && (
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !storeId}
            onClick={() =>
              start(async () => {
                if (!storeId) return;
                const res = await updateMemberRoleAction({
                  storeId,
                  userId: member.user_id,
                  role,
                }).catch(() => ({ ok: false, message: "Error." }));
                if (!res.ok) {
                  toastFormError("No se pudo guardar el rol", res.message);
                  return;
                }
                toast.add({ title: "Rol actualizado", description: res.message, type: "success" });
                router.refresh();
              })
            }
          >
            <Save aria-hidden />
            {pending ? "Guardando…" : "Guardar"}
          </Button>
        )}
      </td>
    </tr>
  );
}

export function TeamPanel({
  members,
  myRole,
  myUserId,
  storeId,
}: {
  members: StoreMember[];
  myRole: MemberRole | null;
  myUserId: string | null;
  storeId: string | null;
}) {
  const canEdit = myRole === "owner" || myRole === "admin";
  return (
    <section role="tabpanel" aria-label="Equipo" className="flex w-full max-w-2xl flex-col gap-4">
      <SectionHeading
        title="Roles del equipo"
        hint="El propietario tiene control total; admin configura, vendedor opera y lector solo consulta."
        tone="primary"
      />
      <AppCard
        title={`Miembros (${members.length})`}
        description={
          myRole
            ? `Tu rol: ${MEMBER_ROLE_LABELS[myRole]}${canEdit ? "" : " (solo lectura)"}`
            : "Sin sesión activa."
        }
      >
        {members.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin miembros.</p>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">Usuario</th>
                <th className="px-4 py-2 font-medium">Rol</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <MemberRow key={`${m.user_id}-${m.role}`} member={m} storeId={storeId} canEdit={canEdit && storeId !== null} isSelf={myUserId === m.user_id} />
              ))}
            </tbody>
          </table>
        )}
      </AppCard>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Siempre debe quedar al menos un propietario. Solo un propietario puede cambiar el rol
        de otro propietario.
      </p>
    </section>
  );
}
