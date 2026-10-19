// Tipos agnósticos del módulo de comunicación.
// web/lib/comms/ agrupa email/WhatsApp; hoy solo email/SendGrid.
export interface CommMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  from?: string;
}

export interface CommResult {
  ok: boolean;
  provider: string;
  messageId?: string;
  error?: string;
}

export interface EmailProviderClient {
  name: string;
  send(msg: CommMessage): Promise<CommResult>;
}
