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
import { attentionList, kpis } from "@/lib/data";

export default function DashboardPage() {
  return (
    <div className="flex w-full flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">Overview</h1>
        <span className="text-xs text-muted-foreground">Oct 2026</span>
      </header>

      <section className="grid grid-cols-3 gap-4">
        {kpis.map((kpi) => (
          <Card key={kpi.label}>
            <CardContent className="flex flex-col gap-1 p-4">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {kpi.label}
              </span>
              <span className="text-2xl font-semibold tabular-nums tracking-tight">
                {kpi.value}
              </span>
              <span className="text-xs text-muted-foreground">{kpi.delta}</span>
            </CardContent>
          </Card>
        ))}
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-medium">Needs attention</h2>
          <span className="text-xs text-muted-foreground">5 pending</span>
        </div>
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  <TableHead>Detail</TableHead>
                  <TableHead className="w-24 text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {attentionList.map((row) => (
                  <TableRow key={row.email}>
                    <TableCell className="font-medium">{row.email}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.detail}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="outline" size="sm">
                        {row.action}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
