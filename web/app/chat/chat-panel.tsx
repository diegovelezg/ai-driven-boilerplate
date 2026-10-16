"use client";

import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AgentFoco } from "@/app/api/chat/route";

export const FOCOS: Array<{ id: AgentFoco; label: string; suggestions: string[] }> = [
  {
    id: "general",
    label: "Tu tienda",
    suggestions: [
      "¿Quién está en riesgo esta semana y por qué?",
      "¿Cuánto recuperamos este mes?",
      "¿Qué hago primero hoy?",
    ],
  },
  {
    id: "scout",
    label: "Scout",
    suggestions: [
      "¿A quién detectaste y por qué?",
      "¿Qué señales son nuevas hoy?",
      "¿Quién está por vencer pero aún no venció?",
    ],
  },
  {
    id: "estratega",
    label: "Estratega",
    suggestions: [
      "¿Por qué este primero y no aquel?",
      "¿Qué significa winback, nurture y vip_care aquí?",
      "¿Cuáles son los 5 de mayor valor en riesgo?",
    ],
  },
  {
    id: "redactor",
    label: "Redactor",
    suggestions: [
      "Muéstrame los borradores pendientes",
      "¿Por qué este tono para este cliente?",
      "Reescribe el último más corto para WhatsApp",
    ],
  },
  {
    id: "prospector",
    label: "Prospector",
    suggestions: [
      "¿Qué leads propusiste y por qué encajan?",
      "Busca negocios como mi cliente ideal",
      "¿Cuál es mi cliente ideal según lo aprendido?",
    ],
  },
  {
    id: "mensajero",
    label: "Mensajero",
    suggestions: [
      "¿Qué hay aprobado en cola para enviar?",
      "¿Qué se envió esta semana?",
      "¿Por qué algo aprobado aún no se envió?",
    ],
  },
  {
    id: "analista",
    label: "Analista",
    suggestions: [
      "¿Cuántos volvieron a comprar y cuánta plata es?",
      "¿Qué mensajes convirtieron mejor?",
      "¿Qué señales se cerraron sin compra?",
    ],
  },
  {
    id: "perfilador",
    label: "Perfilador",
    suggestions: [
      "¿Qué aprendiste de mi negocio?",
      "¿Cada cuánto vuelven mis clientes según mis datos?",
      "¿Mi ciclo configurado sigue teniendo sentido?",
    ],
  },
  {
    id: "vigilancia",
    label: "Vigilancia",
    suggestions: [
      "¿Qué detectó el Scout hoy?",
      "¿Cómo priorizó el Estratega?",
      "¿Quién es lo más urgente y por qué?",
    ],
  },
  {
    id: "propuesta",
    label: "Propuesta",
    suggestions: [
      "¿Qué borradores hay pendientes?",
      "¿Qué leads encontró el Prospector?",
      "Muéstrame lo listo para revisar",
    ],
  },
  {
    id: "cierre",
    label: "Cierre",
    suggestions: [
      "¿Qué se envió y qué volvió?",
      "¿Qué hay aprobado en cola?",
      "¿Cuánto recuperamos este mes?",
    ],
  },
];

export function focoLabel(foco: AgentFoco): string {
  return FOCOS.find((f) => f.id === foco)?.label ?? foco;
}

interface Msg {
  role: "user" | "assistant";
  content: string;
}

function Markdown({ content }: { content: string }) {
  return (
    <div className="text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_code]:rounded [&_code]:bg-background/60 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_h1]:mt-2 [&_h1]:mb-1 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_p]:first:mt-0 [&_p]:last:mb-0 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-background/60 [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_strong]:font-semibold [&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

/** Panel de chat store-scoped: lo usan la página /chat y el drawer del dashboard. */
export function ChatPanel({
  storeId,
  foco,
  onFocoChange,
}: {
  storeId: string;
  foco: AgentFoco;
  onFocoChange: (f: AgentFoco) => void;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Cambiar de foco = conversación nueva (mismo cerebro, otro sombrero).
  const switchFoco = (f: AgentFoco) => {
    if (f === foco) return;
    setMessages([]);
    setError(null);
    setInput("");
    onFocoChange(f);
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const ask = async (text: string) => {
    const q = text.trim();
    if (!q || pending) return;
    setError(null);
    const next: Msg[] = [...messages, { role: "user", content: q }];
    setMessages(next);
    setInput("");
    setPending(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeId, foco, messages: next }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => null);
        throw new Error((j as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
      }
      setMessages((m) => [...m, { role: "assistant", content: "" }]);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const p of parts) {
          const line = p.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const j = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
            const token = j.choices?.[0]?.delta?.content ?? "";
            if (token) {
              setMessages((m) => {
                const copy = [...m];
                const lastMsg = copy[copy.length - 1];
                copy[copy.length - 1] = { role: "assistant", content: lastMsg.content + token };
                return copy;
              });
            }
          } catch {
            // chunk parcial: se reintenta con el siguiente
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falló el agente.");
    } finally {
      setPending(false);
    }
  };

  const active = FOCOS.find((f) => f.id === foco) ?? FOCOS[0];

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {FOCOS.map((f) => (
          <Button
            key={f.id}
            size="sm"
            variant={f.id === foco ? "default" : "outline"}
            disabled={pending && f.id !== foco}
            onClick={() => switchFoco(f.id)}
          >
            {f.label}
          </Button>
        ))}
      </div>

      <div className="flex min-h-64 flex-col gap-3 rounded-lg border bg-card p-4">
        {messages.length === 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-[13px] text-muted-foreground">
              {foco === "general"
                ? "Soy tu equipo IA con foco en tu tienda. Puedo leer señales, borradores y resultados, y lanzar a los especialistas."
                : `Soy tu equipo IA con foco en ${active.label}. Pregúntame de su parte.`}
            </p>
            <div className="flex flex-wrap gap-2">
              {active.suggestions.map((s) => (
                <Button key={s} size="sm" variant="outline" disabled={pending} onClick={() => void ask(s)}>
                  {s}
                </Button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "self-end rounded-lg bg-primary/10 px-3 py-2 text-sm" : "self-start w-full"}>
            {m.role === "user" ? m.content : <Markdown content={m.content || "…"} />}
          </div>
        ))}
        {pending && messages[messages.length - 1]?.role === "user" && (
          <p className="text-[13px] text-muted-foreground">Pensando…</p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div ref={bottomRef} />
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(input);
        }}
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={`Pregunta con foco en ${active.label}…`}
          disabled={pending}
        />
        <Button type="submit" disabled={pending || !input.trim()}>
          <Send className="size-4" aria-hidden />
          Enviar
        </Button>
      </form>
    </div>
  );
}
