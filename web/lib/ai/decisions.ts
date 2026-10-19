// Cliente mínimo para la Decisions API de OpenAI (POST /v1/decisions).
// Sin SDK: fetch directo (el SDK pide >=7.30.0 y no está instalado).
// Docs: https://developers.openai.com/api/docs/guides/decisions
// Solo clasifica (predicate/choice/score con probabilidades); NUNCA genera texto.
// Los errores HTTP lanzan (sin fallback silencioso); `refusal` es un veredicto explícito.

const DECISIONS_MODEL = "gpt-6-luna";
const DECISIONS_URL = "https://api.openai.com/v1/decisions";

interface PredicateQuestion {
  type: "predicate";
  name: string;
  instructions: string;
}

interface ChoiceQuestion {
  type: "choice";
  name: string;
  instructions: string;
  choices: Array<{ value: string; description: string }>;
}

interface ScoreQuestion {
  type: "score";
  name: string;
  instructions: string;
  levels: Array<{ label: string; description: string }>;
}

type DecisionQuestion = PredicateQuestion | ChoiceQuestion | ScoreQuestion;

type DecisionAnswer =
  | { type: "predicate"; name: string; probability: number }
  | {
      type: "choice";
      name: string;
      choice: string;
      probabilities: Array<{ value: string; probability: number }>;
      confidence: number;
    }
  | {
      type: "score";
      name: string;
      score: number;
      probabilities: Array<{ value: number; label: string; probability: number }>;
      confidence: number;
    }
  | { type: "refusal"; name: string };

function apiKey(): string {
  const k = process.env.OPENAI_API_KEY;
  if (!k) throw new Error("Falta OPENAI_API_KEY (requerida por Decisions API)");
  return k;
}

/** Una llamada Decisions: mismo `input` como evidencia, N preguntas independientes. */
async function decide(
  input: string,
  questions: DecisionQuestion[],
): Promise<DecisionAnswer[]> {
  const res = await fetch(DECISIONS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey()}` },
    body: JSON.stringify({ model: DECISIONS_MODEL, input, questions }),
  });
  if (!res.ok) {
    throw new Error(`Decisions ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  const answers = data?.answers;
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new Error("Decisions: respuesta sin answers");
  }
  return answers as DecisionAnswer[];
}

export interface B2bVerdict {
  /** P(el dominio es de un negocio/institución real). */
  probability: number;
  /** null si el modelo rehusó (sin veredicto). */
  isBusiness: boolean | null;
}

/**
 * ¿Parece este dominio de un negocio real? Segunda capa tras `classifyDomain()`
 * (regex gratis): solo se llama con dominios ya `enrichable` para cazar casos
 * borde (personales tipo juanperez.com, typos, basura, parqueados) antes de
 * gastar fetch + extracción. `context` = evidencia local (emails/empresas).
 * CALIBRADO 2026-10-16 (dry-run, 63 dominios, sin escribir): rechazos p≤0.35,
 * gris 0.53-0.65, resto ≥0.72. Threshold 0.5 fail-open: lo gris se enriquece.
 */
export const B2B_GATE_THRESHOLD = 0.5;

export async function judgeBusinessDomain(domain: string, context?: string): Promise<B2bVerdict> {
  const d = domain.trim().toLowerCase();
  const input = context?.trim()
    ? `Domain: ${d}\nLocal evidence (customers using this domain):\n${context.trim().slice(0, 800)}`
    : `Domain: ${d}`;
  const [answer] = await decide(
    input,
    [
      {
        type: "predicate",
        name: "is_b2b",
        instructions:
          "Is this domain likely to belong to a real business, organization, or institution " +
          "with its own website (not a personal, parked, disposable-email, or placeholder domain)? " +
          "Weigh the local evidence heavily: role accounts (info@, ventas@, contacto@) and a declared " +
          "company name suggest business; a single firstnamelastname address with no company suggests personal. " +
          "Judge the name structure and TLD too: company names and country/company TLDs suggest business; " +
          "firstnamelastname patterns, random/keyboard-mash strings (asdfl, tester4, pepito), or " +
          "free-mail-like names suggest personal or fake.",
      },
    ],
  );
  if (answer.type === "refusal") return { probability: 0, isBusiness: null };
  if (answer.type !== "predicate") throw new Error("Decisions: tipo inesperado en is_b2b");
  return { probability: answer.probability, isBusiness: answer.probability >= B2B_GATE_THRESHOLD };
}
