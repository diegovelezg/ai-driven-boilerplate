"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { ArrowUpIcon, RotateCcw } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Message, MessageContent } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Spinner } from "@/components/ui/spinner";
import type { ChatMessage } from "./types";

/** Markdown único para todo chat: vive en Bubble ghost (sin marco, ancho total). */
function ChatMarkdown({ content }: { content: string }) {
  return (
    <div className="text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_code]:rounded [&_code]:bg-background/60 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_h1]:mt-2 [&_h1]:mb-1 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_p]:first:mt-0 [&_p]:last:mb-0 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-background/60 [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_strong]:font-semibold [&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

/** Estado de espera del agente: Marker + Spinner + shimmer (patrón shadcn). */
function ChatThinkingMarker({ label }: { label: string }) {
  return (
    <Message>
      <MessageContent>
        <Marker role="status">
          <MarkerIcon>
            <Spinner />
          </MarkerIcon>
          <MarkerContent className="shimmer">{label}</MarkerContent>
        </Marker>
      </MessageContent>
    </Message>
  );
}

export interface ChatShellProps {
  messages: ChatMessage[];
  input: string;
  onInputChange: (v: string) => void;
  onAsk: (text: string) => void;
  pending: boolean;
  error: string | null;
  /** Reintento del último turno (el hook reenvía sin duplicar la burbuja). */
  onRetry?: () => void;
  /** Trabajo en curso del agente; si llega, reemplaza a thinkingLabel. */
  status?: string | null;
  /** Deshabilita input + sugerencias (p.ej. perfil ya completado). */
  disabled?: boolean;
  /** Sugerencias del estado vacío (un click = un ask). */
  suggestions?: string[];
  /** Rota las sugerencias (pool grande, se muestran 3). */
  onShuffleSuggestions?: () => void;
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
 * SSOT visual de todo chat sobre los nativos shadcn (Chat):
 * MessageScroller (scroll/anclaje) + Message/Bubble (turnos) +
 * Suggestion (fila de presets) + Prompt Input (InputGroup).
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
  onRetry,
  status = null,
  disabled = false,
  suggestions = [],
  onShuffleSuggestions,
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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const prevPendingRef = useRef(pending);
  const canSend = !pending && !disabled && input.trim().length > 0;
  /** Descriptivo en vivo (SSE) con fallback al genérico por contexto. */
  const thinking = status ?? thinkingLabel;

  // Foco inicial: al abrir el chat se escribe sin click previo.
  // Si está deshabilitado (perfil completado), no se roba el foco.
  useEffect(() => {
    if (disabled) return;
    inputRef.current?.focus();
  }, [disabled]);

  // Tras cada respuesta (pending true → false) el foco vuelve al input
  // para el siguiente mensaje. Se hace aquí (SSOT visual) para cubrir
  // store, ficha y perfil sin duplicar lógica.
  useEffect(() => {
    if (prevPendingRef.current && !pending) {
      inputRef.current?.focus();
    }
    prevPendingRef.current = pending;
  }, [pending]);

  return (
    <div className={`flex h-full min-h-0 flex-1 flex-col${className ? ` ${className}` : ""}`}>
      {header}
      <MessageScrollerProvider autoScroll>
        <MessageScroller>
          <MessageScrollerViewport className="px-8 py-6">
            <MessageScrollerContent aria-busy={pending || undefined}>
              {messages.length === 0 ? (
                <div className="m-auto flex flex-col items-center gap-5 py-10 text-center">
                  {emptyAvatar}
                  <div className="grid gap-2">
                    <p className="text-lg font-semibold tracking-tight">{emptyTitle}</p>
                    {emptySubtitle && (
                      <p className="mx-auto max-w-xs text-sm leading-relaxed text-muted-foreground">
                        {emptySubtitle}
                      </p>
                    )}
                  </div>
                  {suggestions.length > 0 && (
                    <div className="grid w-full max-w-sm gap-2">
                      {suggestions.map((s) => (
                        <Button
                          key={s}
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-auto min-h-7 w-full justify-start py-1.5 text-left whitespace-normal"
                          onClick={() => onAsk(s)}
                          disabled={pending || disabled}
                        >
                          {s}
                        </Button>
                      ))}
                      {onShuffleSuggestions && (
                        <button
                          type="button"
                          onClick={onShuffleSuggestions}
                          disabled={pending || disabled}
                          className="mx-auto text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline disabled:opacity-50"
                        >
                          Ver otras preguntas
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                messages.map((m) =>
                  m.role === "user" ? (
                    <MessageScrollerItem key={m.id} messageId={m.id} scrollAnchor>
                      <Message align="end">
                        <MessageContent>
                          <Bubble align="end" variant="muted">
                            <BubbleContent>{m.content}</BubbleContent>
                          </Bubble>
                        </MessageContent>
                      </Message>
                    </MessageScrollerItem>
                  ) : (
                    <MessageScrollerItem key={m.id} messageId={m.id}>
                      <Message>
                        <MessageContent>
                          {m.content ? (
                            <Bubble variant="ghost">
                              <BubbleContent>
                                <ChatMarkdown content={m.content} />
                              </BubbleContent>
                            </Bubble>
                          ) : (
                            <ChatThinkingMarker label={thinking} />
                          )}
                        </MessageContent>
                      </Message>
                    </MessageScrollerItem>
                  ),
                )
              )}
              {pending && messages.length > 0 && messages[messages.length - 1]?.role === "user" && (
                <MessageScrollerItem>
                  <ChatThinkingMarker label={thinking} />
                </MessageScrollerItem>
              )}
              {error && (
                <MessageScrollerItem>
                  <Message>
                    <MessageContent>
                      <div role="alert" className="flex flex-col items-start gap-2">
                        <Bubble variant="destructive">
                          <BubbleContent>{error}</BubbleContent>
                        </Bubble>
                        {onRetry && (
                          <Button type="button" size="sm" variant="outline" onClick={onRetry} disabled={pending}>
                            <RotateCcw aria-hidden />
                            Reintentar
                          </Button>
                        )}
                      </div>
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              )}
              {belowMessages && <MessageScrollerItem>{belowMessages}</MessageScrollerItem>}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>

      <form
        ref={formRef}
        className="border-t border-border/60 px-8 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!disabled) onAsk(input);
        }}
      >
        <InputGroup>
          <InputGroupTextarea
            ref={inputRef}
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            placeholder={placeholder}
            disabled={pending || disabled}
            rows={1}
            aria-label={inputAriaLabel ?? placeholder}
            className="p-3"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                formRef.current?.requestSubmit();
              }
            }}
          />
          <InputGroupAddon align="block-end">
            <InputGroupButton
              type="submit"
              size="icon-sm"
              variant="default"
              className="ml-auto rounded-full"
              disabled={!canSend}
              aria-label="Enviar"
            >
              <ArrowUpIcon aria-hidden />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </form>
    </div>
  );
}
