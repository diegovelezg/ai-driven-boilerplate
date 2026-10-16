"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { EditableCustomer } from "@/lib/customers-db";
import { formatMoney } from "@/lib/medusa";
import { CustomerDrawer } from "./customers/customer-drawer";

export interface AttentionItem {
  signalId: string;
  customerDbId: string;
  kind: string;
  score: number | null;
  reason: string | null;
  email: string;
  name: string;
  ordersCount: number;
  totalSpent: number;
}

export function AttentionTable({
  rows,
  currency,
}: {
  rows: AttentionItem[];
  currency: string | null;
}) {
  const [selected, setSelected] = useState<EditableCustomer | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const open = async (row: AttentionItem) => {
    if (loadingId) return;
    setLoadingId(row.customerDbId);
    try {
      const res = await fetch(`/api/customers/${row.customerDbId}/summary`);
      if (!res.ok) return;
      const j = (await res.json()) as { customer?: EditableCustomer };
      if (j.customer) setSelected(j.customer);
    } finally {
      setLoadingId(null);
    }
  };

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Customer</TableHead>
            <TableHead>Motivo</TableHead>
            <TableHead className="w-24 text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.signalId}
              onClick={() => void open(row)}
              className="cursor-pointer"
            >
              <TableCell className="font-medium">
                {loadingId === row.customerDbId ? "Cargando…" : row.name}
                <span className="block text-xs font-normal text-muted-foreground">
                  {row.email} · {row.ordersCount} compras · {formatMoney(row.totalSpent, currency)}
                  {row.score != null ? ` · score ${row.score}` : ""}
                </span>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {row.reason ?? row.kind}
              </TableCell>
              <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                <Button render={<Link href="/review" />} nativeButton={false} variant="outline" size="sm">
                  Review
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {selected && (
        <CustomerDrawer
          key={selected.dbId}
          customer={selected}
          initialTab="compras"
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}
