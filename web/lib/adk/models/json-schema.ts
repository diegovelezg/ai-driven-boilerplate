/** Convierte un Schema de @google/genai (enums en MAYÚSCULAS) a JSON Schema estándar. */
export function googleSchemaToJsonSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const s = schema as Record<string, unknown>;
  if (s.type === undefined && s.properties === undefined) return s;

  const typeMap: Record<string, string> = {
    OBJECT: "object",
    STRING: "string",
    NUMBER: "number",
    INTEGER: "integer",
    BOOLEAN: "boolean",
    ARRAY: "array",
  };
  const numMap: Record<number, string> = {
    1: "string",
    2: "number",
    3: "integer",
    4: "boolean",
    5: "array",
    6: "object",
  };

  const result: Record<string, unknown> = {};
  if (typeof s.type === "string") {
    result.type = typeMap[s.type] || s.type.toLowerCase();
  } else if (typeof s.type === "number") {
    result.type = numMap[s.type] || "object";
  }
  if (s.description) result.description = s.description;
  if (s.properties && typeof s.properties === "object") {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s.properties as Record<string, unknown>)) {
      props[k] = googleSchemaToJsonSchema(v) || v;
    }
    result.properties = props;
  }
  if (s.items) result.items = googleSchemaToJsonSchema(s.items);
  if (Array.isArray(s.required)) result.required = s.required;
  if (Array.isArray(s.enum)) result.enum = s.enum;
  return result;
}
