"use client";

import { useCallback, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { MemberRole } from "@/lib/roles";
import { DRAWER_PARAMS } from "@/lib/insight-mentions";
import { OrdenDrawer } from "@/app/(dashboard)/orders/orden-drawer";
import { PantallaDrawer } from "@/app/(dashboard)/screens/pantalla-drawer";
import { EmpresaDrawer } from "@/app/(dashboard)/companies/empresa-drawer";
import { MarcaDrawer } from "@/app/(dashboard)/brands/marca-drawer";

// Host central de drawers (fichas laterales): UN solo mecanismo para toda
// la app. Cualquier página abre un drawer seteando su param sobre la URL
// actual (ver `buildDrawerHref` en lib/insight-mentions.ts): no navega, los
// filtros se preservan y cerrar vuelve al estado previo. La URL manda
// (deep-link compartible + back/forward), igual que las listas nativas.
//
// Cada entrada declara su `home`: la página que ya renderiza ese drawer de
// forma nativa (su lista). El host NO renderiza ahí (evita doble drawer);
// en cualquier otra ruta sí. Para registrar un drawer nuevo basta agregar
// una entrada + sus params a DRAWER_PARAMS.
//
// Nota: ContactDrawer no está aquí porque necesita el objeto contacto
// completo (no resoluble por id vía fetch): solo abre nativo en /contacts.

type Entry = {
  params: string[];
  home: string;
  render: (id: string, myRole: MemberRole | null, onClose: () => void) => ReactNode;
};

const ENTRIES: Entry[] = [
  {
    params: ["order", "orden"],
    home: "/orders",
    render: (id, myRole, onClose) => <OrdenDrawer key={id} orderId={id} myRole={myRole} onClose={onClose} />,
  },
  {
    params: ["pantalla", "screen"],
    home: "/screens",
    render: (id, _myRole, onClose) => <PantallaDrawer key={id} screenId={id} onClose={onClose} />,
  },
  {
    params: ["company", "empresa"],
    home: "/companies",
    render: (id, _myRole, onClose) => <EmpresaDrawer key={id} companyId={id} onClose={onClose} />,
  },
  {
    params: ["brand", "marca"],
    home: "/brands",
    render: (id, _myRole, onClose) => <MarcaDrawer key={id} brandName={id} onClose={onClose} />,
  },
];

function pickId(sp: URLSearchParams, params: string[]): string | null {
  for (const p of params) {
    const v = (sp.get(p) ?? "").trim();
    if (v) return v;
  }
  return null;
}

export function DrawerHost({ myRole }: { myRole: MemberRole | null }) {
  const pathname = usePathname();
  const sp = useSearchParams();
  const router = useRouter();

  const close = useCallback(() => {
    const params = new URLSearchParams(sp.toString());
    for (const p of DRAWER_PARAMS) params.delete(p);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [pathname, router, sp]);

  const match = ENTRIES.find((e) => pathname !== e.home && pickId(sp, e.params) !== null);
  if (!match) return null;
  const id = pickId(sp, match.params);
  if (!id) return null;
  return <>{match.render(id, myRole, close)}</>;
}
