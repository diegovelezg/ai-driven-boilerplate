"use client";

import { useActionState, useState, useTransition } from "react";
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
import { revokeSecretAction, saveConnectionsAction, saveEmailAction, testEmailAction } from "@/lib/settings-actions";
import type { RevocableSecret } from "@/lib/settings-actions";
import type { DefaultChannel, EmailProvider, Platform, StoreConnections } from "@/lib/store";

export function SecretRevokeButton({
  secret,
  disabled,
}: {
  secret: RevocableSecret;
  disabled?: boolean;
}) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  if (disabled) return null;
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await revokeSecretAction(secret);
            setMsg(r.message);
          })
        }
      >
        {pending ? "Revocando…" : "Revocar"}
      </Button>
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
    </span>
  );
}

export function SecretsAuditCard({
  audits,
}: {
  audits: Array<{
    id: string;
    keyName: string;
    action: string;
    actor: string | null;
    createdAt: string;
  }>;
}) {
  if (audits.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Auditoría de secretos</CardTitle>
        <CardDescription>Quién/cuándo por key. Nunca se muestra el valor.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
          {audits.map((a) => (
            <li key={a.id} className="tabular-nums">
              {a.keyName} · {a.action} · {a.actor ?? "settings-ui"} ·{" "}
              {a.createdAt ? new Date(a.createdAt).toLocaleString() : "—"}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function SettingsForm({
  defaults,
  secretsInDb,
}: {
  defaults: StoreConnections;
  secretsInDb?: boolean;
}) {
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
            {secretsInDb === true && " Token en DB cifrada."}
            {secretsInDb === false && " Token en JSON local (solo dev)."}
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
        {platform === "medusa" && defaults.medusaToken && (
          <SecretRevokeButton secret="medusa_token" />
        )}
        {platform === "shopify" && defaults.shopifyToken && (
          <SecretRevokeButton secret="shopify_token" />
        )}
        {state && (
          <p className={state.ok ? "text-xs text-green-600" : "text-xs text-destructive"}>
            {state.message}
          </p>
        )}
      </div>
    </form>
  );
}

export function EmailSettingsForm({
  defaults,
  secretsInDb,
}: {
  defaults: StoreConnections;
  secretsInDb?: boolean;
}) {
  const [saveState, saveAction, savePending] = useActionState(saveEmailAction, null);
  const [testState, testAction, testPending] = useActionState(testEmailAction, null);
  const [provider, setProvider] = useState<EmailProvider>(defaults.emailProvider || "sendgrid");
  const [defaultChannel, setDefaultChannel] = useState<DefaultChannel>(
    defaults.defaultChannel || "email",
  );

  return (
    <div className="flex w-full max-w-2xl flex-col gap-4">
      <form action={saveAction} className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">Email transaccional</CardTitle>
              <Badge variant={defaults.emailApiKey ? "default" : "secondary"}>
                {defaults.emailApiKey
                  ? `${provider === "none" ? "Desactivado" : `${provider} conectado`}`
                  : "Sin conectar"}
              </Badge>
            </div>
            <CardDescription>
              Proveedor de envío. Solo se guarda la key, nunca se muestra completa.
              {secretsInDb === true && " Key en DB cifrada."}
              {secretsInDb === false && " Key en JSON local (solo dev)."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="defaultChannel">Canal de contacto por defecto</Label>
              <Select
                name="defaultChannel"
                value={defaultChannel}
                onValueChange={(v) => setDefaultChannel(v as DefaultChannel)}
              >
                <SelectTrigger id="defaultChannel">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="email">Email</SelectItem>
                  <SelectItem value="whatsapp">WhatsApp</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="emailProvider">Proveedor</Label>
              <Select
                name="emailProvider"
                value={provider}
                onValueChange={(v) => setProvider(v as EmailProvider)}
              >
                <SelectTrigger id="emailProvider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sendgrid">SendGrid</SelectItem>
                  <SelectItem value="resend">Resend · próximamente</SelectItem>
                  <SelectItem value="none">Ninguno</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {provider !== "none" && (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="emailFrom">Remitente (from)</Label>
                  <Input
                    id="emailFrom"
                    name="emailFrom"
                    type="email"
                    placeholder="notificaciones@tutienda.com"
                    defaultValue={defaults.emailFrom}
                    autoComplete="off"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="emailApiKey">API key</Label>
                  <Input
                    id="emailApiKey"
                    name="emailApiKey"
                    type="password"
                    placeholder={defaults.emailApiKey ? "•••••••• (guardada, vacío = conservar)" : "SG.…"}
                    autoComplete="off"
                  />
                </div>
              </>
            )}
          </CardContent>
        </Card>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={savePending}>
            {savePending ? "Guardando…" : "Guardar email"}
          </Button>
          {defaults.emailApiKey && <SecretRevokeButton secret="email_api_key" />}
          {saveState && (
            <p className={saveState.ok ? "text-xs text-green-600" : "text-xs text-destructive"}>
              {saveState.message}
            </p>
          )}
        </div>
      </form>

      {provider !== "none" && defaults.emailApiKey && (
        <form action={testAction} className="flex items-center gap-2">
          <Input
            name="emailTestTo"
            type="email"
            placeholder="destino@prueba.com"
            className="max-w-xs"
            required
          />
          <Button type="submit" variant="outline" size="sm" disabled={testPending}>
            {testPending ? "Enviando…" : "Probar envío"}
          </Button>
          {testState && (
            <p className={testState.ok ? "text-xs text-green-600" : "text-xs text-destructive"}>
              {testState.message}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
