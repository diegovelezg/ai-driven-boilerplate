"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { KeyRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AppCard } from "@/components/app-card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { revokeSecretAction, saveEmailAction, testEmailAction } from "@/lib/settings-actions";
import type { RevocableSecret } from "@/lib/settings-actions";
import type { DefaultChannel, EmailProvider, SafeStoreConnections } from "@/lib/store";

function SecretRevokeButton({
  secret,
  storeId,
}: {
  secret: RevocableSecret;
  storeId?: string | null;
}) {
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const router = useRouter();
  if (!confirming) {
    return (
      <Button
        type="button"
        variant="destructive"
        size="sm"
        onClick={() => {
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
            const r = await revokeSecretAction(secret, storeId ?? undefined);
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
    </span>
  );
}

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

export function EmailSettingsForm({
  defaults,
  secretsInDb,
  storeId,
}: {
  defaults: SafeStoreConnections;
  secretsInDb?: boolean;
  storeId?: string | null;
}) {
  const router = useRouter();
  // Guardado y prueba son instantáneos (sin corrida): el resultado va al
  // toast (SSOT), sin texto inline duplicado.
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
        <input type="hidden" name="storeId" value={storeId ?? ""} />
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
              {defaults.hasEmailApiKey && <SecretRevokeButton secret="email_api_key" storeId={storeId} />}
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
            <input type="hidden" name="storeId" value={storeId ?? ""} />
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
          </form>
        </AppCard>
      )}
    </div>
  );
}
