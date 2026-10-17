"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Send } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ChatMessage } from "./types";

/** Markdown único para todo chat: un solo lugar para ajustar estilos. */
export function ChatMarkdown({ content }: { content: string }) {
  return (
    <div className="text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_code]:rounded [&_code]:bg-background/60 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_h1]:mt-2 [&_h1]:mb-1 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_p]:first:mt-0 [&_p]:last:mb-0 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-background/60 [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_strong]:font-semibold [&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

/** Tres puntos con bounce: indicador de typing único para todo chat. */
export function ChatTypingDots({ label }: { label?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 py-1.5"
      role="status"
      aria-label={label ?? "Escribiendo"}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          aria-hidden
          className="size-1.5 animate-bounce rounded-full bg-muted-foreground"
          style={{ animationDelay: `${i * 150}ms` }}
        />
      ))}
    </span>
  );
}

export interface ChatShellProps {
  messages: ChatMessage[];
  input: string;
  onInputChange: (v: string) => void;
  onAsk: (text: string) => void;
  pending: boolean;
  error: string | null;
  /** Sugerencias del estado vacío (un click = un ask). */
  suggestions?: string[];
  emptyTitle: string;
  emptySubtitle?: string;
  /** Avatar/initials del estado vacío (ficha de customer). */
  emptyAvatar?: ReactNode;
  placeholder?: string;
  inputAriaLabel?: string;
  thinkingLabel?: string;
  /** Slot superior y bloque bajo mensajes (propuesta del perfil). */
  header?: ReactNode;
  belowMessages?: ReactNode;
  /** Extra (p.ej. altura máxima cuando va embebido en un formulario). */
  className?: string;
}

/**
 * SSOT visual de todo chat: burbujas, vacío, input, error y autoscroll.
 * Store, ficha y perfil usan este shell; lo distinto va por props/slots,
 * no por componentes duplicados.
 */
export function ChatShell({
  messages,
  input,
  onInputChange,
  onAsk,
  pending,
  error,
  suggestions = [],
  emptyTitle,
  emptySubtitle,
  emptyAvatar,
  placeholder = "Escribe…",
  inputAriaLabel,
  thinkingLabel = "Pensando…",
  header,
  belowMessages,
  className,
}: ChatShellProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  return (
    <div className={`flex h-full min-h-0 flex-1 flex-col${className ? ` ${className}` : ""}`}>
      {header}
      <div className="flex flex-1 flex-col overflow-y-auto px-8 py-6">
        {messages.length === 0 ? (
          <div className="m-auto flex flex-col items-center gap-5 py-10 text-center">
            {emptyAvatar}
            <div className="grid gap-2">
              <p className="text-lg font-medium">{emptyTitle}</p>
              {emptySubtitle && (
                <p className="max-w-xs text-sm text-muted-foreground">{emptySubtitle}</p>
              )}
            </div>
            {suggestions.length > 0 && (
              <div className="flex max-w-sm flex-wrap justify-center gap-2">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => onAsk(s)}
                    disabled={pending}
                    className="rounded-lg border border-border bg-muted/40 px-3.5 py-2 text-[13px] text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
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
                    {m.via && (
                      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        {m.via}
                      </p>
                    )}
                    {m.content ? (
                      <ChatMarkdown content={m.content} />
                    ) : (
                      <ChatTypingDots label={thinkingLabel} />
                    )}
                  </div>
                </div>
              ),
            )}
            {pending && messages[messages.length - 1]?.role === "user" && (
              <p className="text-[13px] text-muted-foreground">{thinkingLabel}</p>
            )}
          </div>
        )}
        {belowMessages}
        <div ref={bottomRef} />
      </div>

      {error && <p className="px-8 pb-2 text-[13px] text-destructive">{error}</p>}

      <form
        className="flex gap-2 border-t border-border/60 px-8 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          onAsk(input);
        }}
      >
        <Input
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          placeholder={placeholder}
          disabled={pending}
          className="h-10"
          aria-label={inputAriaLabel ?? placeholder}
        />
        <Button
          type="submit"
          className="h-10 w-10"
          disabled={pending || !input.trim()}
          aria-label="Enviar"
        >
          <Send className="size-4" aria-hidden />
        </Button>
      </form>
    </div>
  );
}
