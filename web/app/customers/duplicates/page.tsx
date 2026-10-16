import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { resolveStoreId } from "@/lib/customers-db";
import { findDuplicateGroups } from "@/lib/duplicates";
import { formatMoney } from "@/lib/medusa";
import { readConnections } from "@/lib/store";
import { isSupabaseConfigured } from "@/lib/supabase";
import { MergeButton } from "./merge-button";

export const instant = false;

export default async function DuplicatesPage() {
  const conn = await readConnections();
  const ready = Boolean(conn.medusaUrl) && isSupabaseConfigured();

  let groups: Awaited<ReturnType<typeof findDuplicateGroups>> = [];
  let error: string | null = null;
  if (ready) {
    try {
      const storeId = await resolveStoreId(conn.medusaUrl);
      if (!storeId) error = "Tienda sin sincronizar.";
      else groups = await findDuplicateGroups(storeId);
    } catch (e) {
      error = e instanceof Error ? e.message : "Error al leer duplicados.";
    }
  }

  const extraRows = groups.reduce((s, g) => s + (g.rows.length - 1), 0);

  return (
    <div className="flex w-full flex-col gap-6 p-6">
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button
            render={<Link href="/customers" />}
            nativeButton={false}
            variant="ghost"
            size="icon-sm"
            aria-label="Volver"
          >
            <ArrowLeft aria-hidden />
          </Button>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Posibles duplicados</h1>
            <p className="text-xs text-muted-foreground">
              {groups.length} email{groups.length === 1 ? "" : "s"} con más de una ficha
              {extraRows > 0 && ` · ${extraRows} fila${extraRows === 1 ? "" : "s"} extra`}. Solo lectura.
            </p>
          </div>
        </div>
      </header>

      {error && (
        <Card>
          <CardContent className="p-4 text-[13px] text-muted-foreground">{error}</CardContent>
        </Card>
      )}

      {!error && groups.length === 0 && (
        <Card>
          <CardContent className="p-4 text-[13px] text-muted-foreground">
            No se encontraron emails repetidos.
          </CardContent>
        </Card>
      )}

      {groups.map((g) => (
        <Card key={g.email}>
          <CardContent className="p-0">
            <div className="flex items-center justify-between gap-4 border-b px-4 py-3">
              <span className="font-medium text-primary">{g.email}</span>
              <span className="flex items-center gap-3">
                <Badge variant="secondary" className="font-normal">
                  {g.rows.length} fichas
                </Badge>
                <MergeButton dbIds={g.rows.map((r) => r.dbId)} />
              </span>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="px-4">Nombre</TableHead>
                  <TableHead className="px-4">Teléfono</TableHead>
                  <TableHead className="px-4">Empresa</TableHead>
                  <TableHead className="px-4 text-right">Compras</TableHead>
                  <TableHead className="px-4 text-right">Total</TableHead>
                  <TableHead className="px-4">Origen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {g.rows.map((r) => (
                  <TableRow key={r.dbId}>
                    <TableCell className="px-4 py-3">
                      {[r.firstName, r.lastName].filter(Boolean).join(" ") || "—"}
                    </TableCell>
                    <TableCell className="px-4 py-3 text-muted-foreground">{r.phone ?? "—"}</TableCell>
                    <TableCell className="px-4 py-3 text-muted-foreground">{r.companyName ?? "—"}</TableCell>
                    <TableCell className="px-4 py-3 text-right tabular-nums">{r.ordersCount}</TableCell>
                    <TableCell className="px-4 py-3 text-right tabular-nums">
                      {formatMoney(r.totalSpent, r.currency)}
                    </TableCell>
                    <TableCell className="px-4 py-3">
                      <Badge variant={r.source === "local" ? "default" : "outline"} className="font-normal">
                        {r.source === "local" ? "local" : "ecommerce"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
