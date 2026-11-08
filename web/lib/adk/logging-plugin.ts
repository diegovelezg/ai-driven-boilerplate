import { BasePlugin } from "@google/adk";
import { createLogger } from "@/lib/log";

const log = createLogger("adk");

function maxLen(): number {
  const n = Number(process.env.ADK_LOG_MAX ?? 2000);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2000;
}

function verbose(): boolean {
  // Por defecto verboso: el objetivo es ver todo lo que sucede.
  // ADK_LOG_VERBOSE=0 para recortar a errores + resumen.
  return process.env.ADK_LOG_VERBOSE !== "0";
}

function trunc(s: string): string {
  const m = maxLen();
  return s.length > m ? `${s.slice(0, m)}…[truncado ${s.length - m}]` : s;
}

function safe(obj: unknown): string {
  try {
    const s = typeof obj === "string" ? obj : JSON.stringify(obj);
    return trunc(s ?? "?");
  } catch {
    return "[no-serializable]";
  }
}

function runTag(ctx: unknown): string {
  try {
    const c = ctx as Record<string, unknown>;
    const inv = (c?.invocationContext as Record<string, unknown> | undefined)
      ?? (c as Record<string, unknown> | undefined);
    const invocationId =
      (c?.invocationId as string | undefined) ??
      (inv as Record<string, unknown> | undefined)?.invocationId ??
      "?";
    const session = (inv as Record<string, unknown> | undefined)?.session as
      | Record<string, unknown>
      | undefined;
    const sessionId = (session?.sessionId as string | undefined) ?? "?";
    return `run=${String(invocationId).slice(0, 12)} session=${String(sessionId).slice(0, 24)}`;
  } catch {
    return "run=? session=?";
  }
}

function contentPreview(content: unknown): string {
  try {
    const c = content as { parts?: Array<Record<string, unknown>> } | undefined;
    const parts = c?.parts ?? [];
    const out: string[] = [];
    for (const p of parts) {
      if (typeof p.text === "string" && p.text) out.push(`text(${p.text.length}): ${p.text.slice(0, 300)}`);
      else if (p.functionCall) {
        const fc = p.functionCall as Record<string, unknown>;
        out.push(`call ${String(fc.name)}(${safe(fc.args)})`);
      } else if (p.functionResponse) {
        const fr = p.functionResponse as Record<string, unknown>;
        out.push(`result ${String(fr.name)}: ${safe(fr.response).slice(0, 300)}`);
      } else out.push(Object.keys(p).join(","));
    }
    return trunc(out.join(" | ") || "(sin partes)");
  } catch {
    return "(preview-fallo)";
  }
}

/**
 * Plugin ADK que vuelca todo el ciclo a consola + `.data/adk.log`
 * (grep-friendly: `run=… etapa=…`).
 *
 * Cubre: mensaje usuario, inicio/fin de run, agente, modelo
 * (request/response + errores) y tools (args/resultado + errores).
 * No altera el flujo: todos los callbacks devuelven undefined,
 * salvo que ADK exija el tipo (onEvent).
 */
export class AdkLoggingPlugin extends BasePlugin {
  constructor() {
    super("adk_logging");
  }

  override async onUserMessageCallback(params: {
    invocationContext: unknown;
    userMessage: unknown;
  }): Promise<undefined> {
    log(`${runTag(params.invocationContext)} etapa=user_msg ${contentPreview(params.userMessage)}`);
    return undefined;
  }

  override async beforeRunCallback(params: {
    invocationContext: unknown;
  }): Promise<undefined> {
    log(`${runTag(params.invocationContext)} etapa=run_start`);
    return undefined;
  }

  override async afterRunCallback(params: {
    invocationContext: unknown;
  }): Promise<void> {
    log(`${runTag(params.invocationContext)} etapa=run_end`);
  }

  override async onEventCallback(params: {
    invocationContext: unknown;
    event: unknown;
  }): Promise<undefined> {
    if (!verbose()) return undefined;
    try {
      const e = params.event as Record<string, unknown>;
      const author = String(e.author ?? "?");
      const partial = (e.partial as boolean | undefined) ? " parcial" : "";
      // Los eventos parciales spamean: una línea corta basta.
      if (e.partial) {
        log(`${runTag(params.invocationContext)} etapa=event autor=${author}${partial}`);
        return undefined;
      }
      log(
        `${runTag(params.invocationContext)} etapa=event autor=${author}${partial} ${contentPreview(e.content)}`,
      );
    } catch {
      log(`${runTag(params.invocationContext)} etapa=event (ilegible)`);
    }
    return undefined;
  }

  override async beforeAgentCallback(params: {
    agent: unknown;
    callbackContext: unknown;
  }): Promise<undefined> {
    const name =
      (params.agent as { name?: unknown } | undefined)?.name ?? "?";
    log(`${runTag(params.callbackContext)} etapa=agent_start agente=${String(name)}`);
    return undefined;
  }

  override async afterAgentCallback(params: {
    agent: unknown;
    callbackContext: unknown;
  }): Promise<undefined> {
    const name =
      (params.agent as { name?: unknown } | undefined)?.name ?? "?";
    log(`${runTag(params.callbackContext)} etapa=agent_end agente=${String(name)}`);
    return undefined;
  }

  override async beforeModelCallback(params: {
    callbackContext: unknown;
    llmRequest: unknown;
  }): Promise<undefined> {
    if (!verbose()) return undefined;
    try {
      const r = params.llmRequest as Record<string, unknown>;
      const model = String(r.model ?? "?");
      const contents = Array.isArray(r.contents) ? r.contents.length : "?";
      const tools = r.toolsDict ? Object.keys(r.toolsDict as object).length : 0;
      log(
        `${runTag(params.callbackContext)} etapa=model_req modelo=${model} contenidos=${String(contents)} tools=${tools}`,
      );
    } catch {
      log(`${runTag(params.callbackContext)} etapa=model_req (ilegible)`);
    }
    return undefined;
  }

  override async afterModelCallback(params: {
    callbackContext: unknown;
    llmResponse: unknown;
  }): Promise<undefined> {
    if (!verbose()) return undefined;
    try {
      const r = params.llmResponse as Record<string, unknown>;
      log(
        `${runTag(params.callbackContext)} etapa=model_res finish=${String(r.finishReason ?? "?")} ${contentPreview(r.content)}`,
      );
    } catch {
      log(`${runTag(params.callbackContext)} etapa=model_res (ilegible)`);
    }
    return undefined;
  }

  override async onModelErrorCallback(params: {
    callbackContext: unknown;
    llmRequest: unknown;
    error: unknown;
  }): Promise<undefined> {
    const msg = params.error instanceof Error ? params.error.message : safe(params.error);
    let model = "?";
    try {
      model = String((params.llmRequest as Record<string, unknown>)?.model ?? "?");
    } catch {
      // modelo desconocido: igual se loguea el error
    }
    log(`${runTag(params.callbackContext)} etapa=model_ERROR modelo=${model} error=${trunc(msg)}`);
    return undefined;
  }

  override async beforeToolCallback(params: {
    tool: unknown;
    toolArgs: unknown;
    toolContext: unknown;
  }): Promise<undefined> {
    const name =
      (params.tool as { name?: unknown } | undefined)?.name ?? "?";
    log(
      `${runTag(params.toolContext)} etapa=tool_start tool=${String(name)} args=${safe(params.toolArgs)}`,
    );
    return undefined;
  }

  override async afterToolCallback(params: {
    tool: unknown;
    toolContext: unknown;
    result: unknown;
  }): Promise<undefined> {
    const name =
      (params.tool as { name?: unknown } | undefined)?.name ?? "?";
    log(
      `${runTag(params.toolContext)} etapa=tool_end tool=${String(name)} result=${safe(params.result)}`,
    );
    return undefined;
  }

  override async onToolErrorCallback(params: {
    tool: unknown;
    toolArgs: unknown;
    toolContext: unknown;
    error: unknown;
  }): Promise<undefined> {
    const name =
      (params.tool as { name?: unknown } | undefined)?.name ?? "?";
    const msg = params.error instanceof Error ? params.error.message : safe(params.error);
    log(
      `${runTag(params.toolContext)} etapa=tool_ERROR tool=${String(name)} args=${safe(params.toolArgs)} error=${trunc(msg)}`,
    );
    return undefined;
  }
}
