"use client";

import { useActionState, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { saveConnectionsAction } from "@/lib/settings-actions";
import type { Platform, StoreConnections } from "@/lib/store";

export function SettingsForm({ defaults }: { defaults: StoreConnections }) {
  const [state, action, pending] = useActionState(saveConnectionsAction, null);
  const [platform, setPlatform] = useState<Platform>(defaults.platform);

  return (
    <form action={action} className="flex w-full max-w-2xl flex-col gap-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium">Ecommerce</CardTitle>
            {platform === "medusa" ? (
              <Badge variant={defaults.medusaToken ? "default" : "secondary"}>
                {defaults.medusaToken
                  ? `Medusa ${defaults.medusaVersion || ""} conectado`.trim()
                  : "Medusa sin conectar"}
              </Badge>
            ) : (
              <Badge variant="outline">Shopify · próximamente</Badge>
            )}
          </div>
          <CardDescription>
            Elige la plataforma. Solo se guarda el token, nunca el password.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="platform">Plataforma</Label>
            <Select
              name="platform"
              value={platform}
              onValueChange={(v) => setPlatform(v as Platform)}
            >
              <SelectTrigger id="platform">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="medusa">Medusa</SelectItem>
                <SelectItem value="shopify">Shopify</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {platform === "medusa" ? (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="medusaUrl">Backend URL</Label>
                <Input
                  id="medusaUrl"
                  name="medusaUrl"
                  placeholder="https://api.tutienda.com"
                  defaultValue={defaults.medusaUrl}
                  inputMode="url"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="medusaVersion">Versión</Label>
                <Select
                  name="medusaVersion"
                  defaultValue={defaults.medusaVersion || "v1"}
                >
                  <SelectTrigger id="medusaVersion">
                    <SelectValue placeholder="Versión de Medusa" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="v1">v1</SelectItem>
                    <SelectItem value="v2">v2</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="medusaEmail">Admin email</Label>
                <Input
                  id="medusaEmail"
                  name="medusaEmail"
                  type="email"
                  placeholder="admin@tutienda.com"
                  defaultValue={defaults.medusaEmail}
                  autoComplete="username"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="medusaPassword">Admin password</Label>
                <Input
                  id="medusaPassword"
                  name="medusaPassword"
                  type="password"
                  placeholder="••••••••"
                  autoComplete="current-password"
                />
              </div>
            </>
          ) : (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="shopifyStore">Store domain</Label>
                <Input
                  id="shopifyStore"
                  name="shopifyStore"
                  placeholder="tutienda.myshopify.com"
                  defaultValue={defaults.shopifyStore}
                  disabled
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="shopifyToken">Access token</Label>
                <Input
                  id="shopifyToken"
                  name="shopifyToken"
                  type="password"
                  placeholder="••••••••"
                  defaultValue={defaults.shopifyToken}
                  autoComplete="off"
                  disabled
                />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Conectando…" : "Guardar y conectar"}
        </Button>
        {state && (
          <p className={state.ok ? "text-xs text-green-600" : "text-xs text-destructive"}>
            {state.message}
          </p>
        )}
      </div>
    </form>
  );
}
