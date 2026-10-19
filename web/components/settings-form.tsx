"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { KeyRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AppCard } from "@/components/app-card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useBackgroundOrNull } from "@/components/background-status";
import { toast } from "@/components/ui/toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { revokeSecretAction, saveConnectionsAction, saveEmailAction, testEmailAction } from "@/lib/settings-actions";
import type { RevocableSecret } from "@/lib/settings-actions";
import type { DefaultChannel, EmailProvider, Platform, SafeStoreConnections } from "@/lib/store";

/** Revocar es destructivo y solo existe cuando hay key: dos pasos
 *  (Revocar → confirmar) y refresh para reflejar el estado real. */
function SecretRevokeButton({
  secret,
}: {
  secret: RevocableSecret;
}) {
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();
  if (!confirming) {
    return (
      <Button
        type="button"
        variant="destructive"
        size="sm"
        onClick={() => {
          setMsg(null);
          setConfirming(true);
        }}
      >
        Revocar
      </Button>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">¿Revocar la key guardada?</span>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await revokeSecretAction(secret);
            setMsg(r.message);
            if (r.ok) {
              toast.add({ title: "Secreto revocado", description: r.message, type: "success" });
              setConfirming(false);
              router.refresh();
            } else {
              toast.add({ title: "No se pudo revocar", description: r.message, type: "error" });
            }
          })
        }
      >
        {pending ? "Revocando…" : "Sí, revocar"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() => setConfirming(false)}
      >
        Cancelar
      </Button>
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
    </span>
  );
}

/** Secreto ya guardado: bloqueado y enmascarado, nunca se muestra.
 *  El reemplazo es explícito (estándar Vercel/GitHub/Stripe). */
function LockedSecret({
  label,
  storageHint,
  onReplace,
}: {
  label: string;
  storageHint: string;
  onReplace: () => void;
}) {
  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-input bg-muted/40 px-3 py-2">
        <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="text-sm tracking-widest tabular-nums" aria-label="Key guardada (oculta)">
          ••••••••
        </span>
        <Badge variant="success">Guardada</Badge>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={onReplace}
        >
          Reemplazar
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{storageHint}</p>
    </div>
  );
}

export function SettingsForm({
  defaults,
  secretsInDb,
}: {
  defaults: SafeStoreConnections;
  secretsInDb?: boolean;
}) {
  // MO único: el connect (login + sync) va a la cinta global vía `bg.start`
  // (el server devuelve el run `sync` y el toast muestra el progreso); el
  // resultado también deja toast de éxito/error en el mismo canal.
  const [state, setState] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, startSave] = useTransition();
  const [platform, setPlatform] = useState<Platform>(defaults.platform);
  const router = useRouter();
  const bg = useBackgroundOrNull();
  // Medusa exige password en cada guardado (no hay "conservar token"):
  // con token, todo el bloque se bloquea hasta "Cambiar credenciales".
  // `defaults` solo trae booleanos has* (los secretos nunca viajan al cliente).
  const hasToken =
    platform === "medusa" ? defaults.hasMedusaToken : defaults.hasShopifyToken;
  // La plataforma queda fijada mientras haya cualquier credencial guardada:
  // cambiarla con un token vivo deja secretos huérfanos y rompe el sync.
  // Solo se libera al revocar el token.
  const hasAnyToken = defaults.hasMedusaToken || defaults.hasShopifyToken;
  const [editing, setEditing] = useState(false);
  const locked = hasToken && !editing;
  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startSave(async () => {
      const r = bg
        ? await bg.start(async () => {
            const x = await saveConnectionsAction(null, fd);
            return { ok: x.ok, message: x.message, run: x.run ?? null };
          })
        : await saveConnectionsAction(null, fd);
      setState({ ok: r.ok, message: r.message });
      if (r.ok) {
        toast.add({ title: "Tienda conectada", description: r.message, type: "success" });
        queueMicrotask(() => setEditing(false));
        // `bg.start()` ya refrescó; repetirlo aborta el RSC en vuelo.
        if (!bg) router.refresh();
      } else {
        toast.add({ title: "No se pudo conectar", description: r.message, type: "error" });
      }
    });
  };

  return (
    <form onSubmit={onSubmit} className="flex w-full flex-col gap-4">
      <AppCard
        tone="primary"
        title="Ecommerce"
        description={
          <>
            Elige la plataforma. Solo se guarda el token, nunca el password.
            {secretsInDb === true && " Token en DB cifrada."}
            {secretsInDb === false && " Token en JSON local (solo dev)."}
          </>
        }
        action={
          platform === "medusa" ? (
            <Badge variant={defaults.hasMedusaToken ? "success" : "secondary"}>
              {defaults.hasMedusaToken
                ? `Medusa ${defaults.medusaVersion || ""} conectado`.trim()
                : "Medusa sin conectar"}
            </Badge>
          ) : (
            <Badge variant="outline">Shopify · próximamente</Badge>
          )
        }
        footer={
          <span className="flex flex-wrap items-center gap-3">
            {locked ? (
              <Button type="button" variant="outline" onClick={() => setEditing(true)}>
                Cambiar credenciales
              </Button>
            ) : (
              <>
                <Button type="submit" disabled={pending}>
                  {pending ? "Conectando…" : "Guardar y conectar"}
                </Button>
                {hasToken && (
                  <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                    Cancelar
                  </Button>
                )}
              </>
            )}
            {platform === "medusa" && defaults.hasMedusaToken && (
              <SecretRevokeButton secret="medusa_token" />
            )}
            {platform === "shopify" && defaults.hasShopifyToken && (
              <SecretRevokeButton secret="shopify_token" />
            )}
            {state && (
              <span className={state.ok ? "text-xs text-green-600" : "text-xs text-destructive"}>
                {state.message}
              </span>
            )}
          </span>
        }
        contentClassName="flex flex-col gap-4"
      >
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-4">
            <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              Plataforma
            </p>
            <div className="grid gap-2">
              <Label htmlFor="platform">Plataforma</Label>
              <Select
                name="platform"
                value={platform}
                onValueChange={(v) => setPlatform(v as Platform)}
                disabled={hasAnyToken}
              >
                <SelectTrigger id="platform">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="medusa">Medusa</SelectItem>
                  <SelectItem value="shopify">Shopify</SelectItem>
                </SelectContent>
              </Select>
              {hasAnyToken && (
                <>
                  <input type="hidden" name="platform" value={platform} />
                  <p className="text-xs text-muted-foreground">
                    Plataforma fijada mientras haya credenciales guardadas. Revoca el token para cambiarla.
                  </p>
                </>
              )}
            </div>
          </div>

          {platform === "medusa" ? (
            <>
              <hr className="border-border/60" />
              <div className="flex flex-col gap-4">
                <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  Servidor
                </p>
                <div className="grid gap-2">
                  <Label htmlFor="medusaUrl">Backend URL</Label>
                  <Input
                    id="medusaUrl"
                    name="medusaUrl"
                    placeholder="https://api.tutienda.com"
                    defaultValue={defaults.medusaUrl}
                    inputMode="url"
                    disabled={locked}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="medusaVersion">Versión</Label>
                  <Select
                    name="medusaVersion"
                    defaultValue={defaults.medusaVersion || "v1"}
                    disabled={locked}
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
              </div>
              <hr className="border-border/60" />
              <div className="flex flex-col gap-4">
                <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  Credenciales
                </p>
                <div className="grid gap-2">
                  <Label htmlFor="medusaEmail">Admin email</Label>
                  <Input
                    id="medusaEmail"
                    name="medusaEmail"
                    type="email"
                    placeholder="admin@tutienda.com"
                    defaultValue={defaults.medusaEmail}
                    autoComplete="username"
                    disabled={locked}
                  />
                </div>
                {locked ? (
                  <LockedSecret
                    label="Token"
                    storageHint={`Token guardado ${secretsInDb === true ? "en DB cifrada" : "local (solo dev)"} — nunca se muestra. Usa “Cambiar credenciales” para rotarlo.`}
                    onReplace={() => setEditing(true)}
                  />
                ) : (
                  <div className="grid gap-2">
                    <Label htmlFor="medusaPassword">Admin password</Label>
                    <Input
                      id="medusaPassword"
                      name="medusaPassword"
                      type="password"
                      placeholder={hasToken ? "Nueva password (requerida para reconectar)" : "••••••••"}
                      autoComplete="current-password"
                    />
                    <p className="text-xs text-muted-foreground">
                      Solo se usa para obtener el token; nunca se guarda.
                    </p>
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <hr className="border-border/60" />
              <div className="flex flex-col gap-4">
                <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  Credenciales
                </p>
                <div className="grid gap-2">
                  <Label htmlFor="shopifyStore">Store domain</Label>
                <Input
                  id="shopifyStore"
                  name="shopifyStore"
                  placeholder="tutienda.myshopify.com"
                  defaultValue={defaults.shopifyStore}
                  disabled
                />
              </div>
              {defaults.hasShopifyToken ? (
                <LockedSecret
                  label="Access token"
                  storageHint={`Token guardado ${secretsInDb === true ? "en DB cifrada" : "local (solo dev)"} — nunca se muestra. Revoca para rotarlo.`}
                  onReplace={() => setEditing(true)}
                />
              ) : (
                <div className="grid gap-2">
                  <Label htmlFor="shopifyToken">Access token</Label>
                  <Input
                    id="shopifyToken"
                    name="shopifyToken"
                    type="password"
                    placeholder="••••••••"
                    autoComplete="off"
                    disabled
                  />
                </div>
              )}
            </div>
            </>
          )}
        </div>
      </AppCard>
    </form>
  );
}

export function EmailSettingsForm({
  defaults,
  secretsInDb,
}: {
  defaults: SafeStoreConnections;
  secretsInDb?: boolean;
}) {
  const router = useRouter();
  // Guardado y prueba son instantáneos (sin corrida): el MO único pide el
  // mismo canal de toasts para el resultado, no solo el texto inline.
  const [saveState, setSaveState] = useState<{ ok: boolean; message: string } | null>(null);
  const [testState, setTestState] = useState<{ ok: boolean; message: string } | null>(null);
  const [savePending, startSave] = useTransition();
  const [testPending, startTest] = useTransition();
  const [provider, setProvider] = useState<EmailProvider>(defaults.emailProvider || "sendgrid");
  const [defaultChannel, setDefaultChannel] = useState<DefaultChannel>(
    defaults.defaultChannel || "email",
  );
  // Paridad con Tienda: con key guardada, todo el bloque se bloquea hasta
  // "Cambiar" (la key vacía conserva la actual, así que desbloquear para
  // tocar canal/proveedor/from no obliga a rotar).
  // `defaults` solo trae hasEmailApiKey (el valor nunca viaja al cliente).
  const hasKey = defaults.hasEmailApiKey;
  const [editingKey, setEditingKey] = useState(false);
  const keyLocked = hasKey && !editingKey && provider !== "none";
  const onSave = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startSave(async () => {
      const r = await saveEmailAction(null, fd);
      setSaveState(r);
      if (r.ok) {
        toast.add({ title: "Email guardado", description: r.message, type: "success" });
        queueMicrotask(() => setEditingKey(false));
        router.refresh();
      } else {
        toast.add({ title: "No se pudo guardar", description: r.message, type: "error" });
      }
    });
  };
  const onTest = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTest(async () => {
      const r = await testEmailAction(null, fd);
      setTestState(r);
      toast.add({
        title: r.ok ? "Prueba enviada" : "La prueba falló",
        description: r.message,
        type: r.ok ? "success" : "error",
      });
    });
  };

  return (
    <div className="flex w-full flex-col gap-4">
      <form onSubmit={onSave} className="flex flex-col gap-4">
        <AppCard
          tone="sky"
          title="Email transaccional"
          description={
            <>
              Proveedor de envío. Solo se guarda la key, nunca se muestra completa.
              {secretsInDb === true && " Key en DB cifrada."}
              {secretsInDb === false && " Key en JSON local (solo dev)."}
            </>
          }
          action={
            <Badge variant={defaults.hasEmailApiKey ? "success" : "secondary"}>
              {defaults.hasEmailApiKey
                ? `${defaults.emailProvider === "none" ? "Desactivado" : `${defaults.emailProvider} conectado`}`
                : "Sin conectar"}
            </Badge>
          }
          footer={
            <span className="flex flex-wrap items-center gap-3">
              {keyLocked ? (
                <Button type="button" variant="outline" onClick={() => setEditingKey(true)}>
                  Cambiar credenciales
                </Button>
              ) : (
                <>
                  <Button type="submit" disabled={savePending}>
                    {savePending ? "Guardando…" : "Guardar email"}
                  </Button>
                  {hasKey && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setProvider(defaults.emailProvider || "sendgrid");
                        setDefaultChannel(defaults.defaultChannel || "email");
                        setEditingKey(false);
                      }}
                    >
                      Cancelar
                    </Button>
                  )}
                </>
              )}
              {defaults.hasEmailApiKey && <SecretRevokeButton secret="email_api_key" />}
              {saveState && (
                <span className={saveState.ok ? "text-xs text-green-600" : "text-xs text-destructive"}>
                  {saveState.message}
                </span>
              )}
            </span>
          }
          contentClassName="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-4">
              <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                Canal
              </p>
              <div className="grid gap-2">
                <Label htmlFor="defaultChannel">Canal de contacto por defecto</Label>
                <Select
                  name="defaultChannel"
                  value={defaultChannel}
                  onValueChange={(v) => setDefaultChannel(v as DefaultChannel)}
                  disabled={keyLocked}
                >
                  <SelectTrigger id="defaultChannel">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="email">Email</SelectItem>
                    <SelectItem value="whatsapp">WhatsApp</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Dónde se escriben los borradores cuando el cliente tiene ambos.
                </p>
              </div>
            </div>
            <hr className="border-border/60" />
            <div className="flex flex-col gap-4">
              <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                Proveedor
              </p>
              <div className="grid gap-2">
                <Label htmlFor="emailProvider">Proveedor</Label>
                <Select
                  name="emailProvider"
                  value={provider}
                  onValueChange={(v) => setProvider(v as EmailProvider)}
                  disabled={keyLocked}
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
                  <div className="grid gap-2">
                    <Label htmlFor="emailFrom">Remitente (from)</Label>
                    <Input
                      id="emailFrom"
                      name="emailFrom"
                      type="email"
                      placeholder="notificaciones@tutienda.com"
                      defaultValue={defaults.emailFrom}
                      autoComplete="off"
                      disabled={keyLocked}
                    />
                  </div>
                  {keyLocked ? (
                    <LockedSecret
                      label="API key"
                      storageHint={`Key guardada ${secretsInDb === true ? "en DB cifrada" : "local (solo dev)"} — nunca se muestra. Vacío conserva; Reemplazar para rotar.`}
                      onReplace={() => setEditingKey(true)}
                    />
                  ) : (
                    <div className="grid gap-2">
                      <Label htmlFor="emailApiKey">API key</Label>
                      <Input
                        id="emailApiKey"
                        name="emailApiKey"
                        type="password"
                        placeholder={hasKey ? "Nueva key (vacío = conservar la actual)" : "SG.…"}
                        autoComplete="off"
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </AppCard>
      </form>

      {defaults.emailProvider !== "none" && defaults.hasEmailApiKey && (
        <AppCard
          tone="sky"
          title="Probar envío"
          description="Verifica que la key y el remitente funcionan antes de aprobar mensajes."
        >
          <form onSubmit={onTest} className="flex flex-col gap-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
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
            </div>
            {testState && (
              <p className={testState.ok ? "text-xs text-green-600" : "text-xs text-destructive"}>
                {testState.message}
              </p>
            )}
          </form>
        </AppCard>
      )}
    </div>
  );
}
