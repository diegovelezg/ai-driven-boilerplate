"use client";

import { useState, useTransition } from "react";
import { AppCard } from "@/components/app-card";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/section-heading";
import { MEMBER_ROLES, MEMBER_ROLE_LABELS, type MemberRole } from "@/lib/roles";
import { updateMemberRoleAction } from "@/lib/members-actions";
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
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <tr className="border-b last:border-0">
      <td className="px-4 py-2 text-sm">
        {member.email ?? `${member.user_id.slice(0, 8)}…`}
        {isSelf && <span className="ml-2 text-xs text-muted-foreground">(tú)</span>}
      </td>
      <td className="px-4 py-2 text-xs">
        {canEdit ? (
          <select
            value={role}
            onChange={(e) => {
              setRole(e.target.value as MemberRole);
              setMsg(null);
            }}
            disabled={pending}
            className="h-7 rounded-lg border border-border bg-background px-1.5 text-xs"
            aria-label={`Rol de ${member.email ?? member.user_id}`}
          >
            {MEMBER_ROLES.map((r) => (
              <option key={r} value={r}>
                {MEMBER_ROLE_LABELS[r]}
              </option>
            ))}
          </select>
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
                setMsg(res.message);
              })
            }
          >
            {pending ? "Guardando…" : "Guardar"}
          </Button>
        )}
        {msg && <span className="ml-2 text-xs text-muted-foreground">{msg}</span>}
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
        title="Equipo y roles"
        hint="Quién accede a esta tienda y con qué rol. Owner > Admin > Vendedor > Lector. Los features se separarán por rol."
        tone="primary"
      />
      <AppCard
        title={`Miembros (${members.length})`}
        description={
          myRole
            ? `Tu rol: ${MEMBER_ROLE_LABELS[myRole]}${canEdit ? "" : " (solo lectura)"}`
            : "Sin sesión: vista de desarrollo."
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
                <MemberRow key={m.user_id} member={m} storeId={storeId} canEdit={canEdit && storeId !== null} isSelf={myUserId === m.user_id} />
              ))}
            </tbody>
          </table>
        )}
      </AppCard>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Lector ve · Vendedor opera (CRM, review) · Admin configura y gestiona vendedores ·
        Propietario gestiona todo (único que puede tocar propietarios; siempre queda uno).
      </p>
    </section>
  );
}
