import { Runner, type BaseAgent, type BaseSessionService } from "@google/adk";
import { RetainLoggingPlugin } from "./logging-plugin";

// Plugin único: si ADK_LOG=0 se corre sin observabilidad (tests silenciosos).
function plugins(): RetainLoggingPlugin[] {
  if (process.env.ADK_LOG === "0") return [];
  return [new RetainLoggingPlugin()];
}

/**
 * Constructor único de Runner: todo el ADK pasa por aquí para que el
 * logging (run/agent/model/tool + errores) sea total. No usar `new Runner`
 * directamente en routes/scripts.
 */
export function createAdkRunner(opts: {
  agent: BaseAgent;
  appName: string;
  sessionService: BaseSessionService;
}): Runner {
  return new Runner({
    agent: opts.agent,
    appName: opts.appName,
    sessionService: opts.sessionService,
    plugins: plugins(),
  } as unknown as ConstructorParameters<typeof Runner>[0]);
}
