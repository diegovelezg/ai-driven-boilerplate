"use client";

import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const SUGGESTED = [
  "Resúmelo en 2 líneas",
  "¿Está en riesgo de irse? ¿Por qué?",
  "¿Qué compró y cuándo fue lo último?",
  "¿Qué oferta le harías para que vuelva?",
];

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

export function CustomerChat({ dbId, customerName }: { dbId: string; customerName: string }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const initials = customerName
    .replace(/[^a-zA-Záéíóúñü@. ]/g, "")
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const appendToken = (token: string) =>
    setMessages((m) => {
      if (m.length === 0) return m;
      const copy = [...m];
      const last = copy[copy.length - 1];
      copy[copy.length - 1] = { role: "assistant", content: last.content + token };
      return copy;
    });

  const ask = async (text: string) => {
    const q = text.trim();
    if (!q || pending) return;
    setError(null);
    const next: Msg[] = [...messages, { role: "user", content: q }];
    setMessages(next);
    setInput("");
    setPending(true);
    try {
      const res = await fetch(`/api/customers/${dbId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => null);
        throw new Error(
          (j as { error?: string } | null)?.error ?? `HTTP ${res.status}`,
        );
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
        for (const part of parts) {
          for (const line of part.split("\n")) {
            const t = line.trim();
            if (!t.startsWith("data:")) continue;
            const payload = t.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const json = JSON.parse(payload) as {
                choices?: Array<{ delta?: { content?: string } }>;
              };
              const token = json.choices?.[0]?.delta?.content;
              if (token) appendToken(token);
            } catch {
              // chunk parcial: se completa con el siguiente read
            }
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falló el chat.");
      setMessages((m) =>
        m.length > 0 && m[m.length - 1].role === "assistant" && !m[m.length - 1].content
          ? m.slice(0, -1)
          : m,
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex flex-1 flex-col overflow-y-auto px-8 py-6">
        {messages.length === 0 ? (
          <div className="m-auto flex flex-col items-center gap-5 py-10 text-center">
            <div
              aria-hidden
              className="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-sm font-semibold tracking-wide text-primary"
            >
              {initials || "—"}
            </div>
            <div className="grid gap-2">
              <p className="text-lg font-medium">Pregunta por este customer</p>
              <p className="max-w-xs text-sm text-muted-foreground">
                Leo su ficha y su historial de compras para responder.
              </p>
            </div>
            <div className="flex max-w-sm flex-wrap justify-center gap-2">
              {SUGGESTED.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void ask(s)}
                  disabled={pending}
                  className="rounded-lg border border-border bg-muted/40 px-3.5 py-2 text-[13px] text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="grid gap-4">
            {messages.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="flex justify-end">
                  <p className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-primary-foreground">
                    {m.content}
                  </p>
                </div>
              ) : (
                <div key={i} className="flex justify-start">
                  <div className="max-w-[95%] rounded-2xl rounded-bl-md bg-muted px-4 py-2.5">
                    {m.content ? (
                      <Markdown content={m.content} />
                    ) : (
                      <span className="animate-pulse text-muted-foreground">…</span>
                    )}
                  </div>
                </div>
              ),
            )}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && <p className="px-8 pb-2 text-[13px] text-destructive">{error}</p>}

      <form
        className="flex gap-2 border-t border-border/60 px-8 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(input);
        }}
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Pregunta por este customer…"
          disabled={pending}
          className="h-10"
          aria-label="Pregunta por este customer"
        />
        <Button type="submit" size="icon" disabled={pending || !input.trim()} aria-label="Enviar">
          <Send className="size-4" aria-hidden />
        </Button>
      </form>
    </div>
  );
}
