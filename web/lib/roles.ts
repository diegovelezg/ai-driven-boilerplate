// Roles de usuario por tenant (B2B). Puro: sin BD, testeable con tsx --test.
// Jerarquía: owner(4) > admin(3) > seller(2) > viewer(1).
// El rol vive en `sys_memberships.role` (una fila por tienda+usuario).
// Para separar features por rol más adelante: FEATURE_MIN_ROLE + hasMinRole.

export const MEMBER_ROLES = ["owner", "admin", "seller", "viewer"] as const;

export type MemberRole = (typeof MEMBER_ROLES)[number];

export const MEMBER_ROLE_LABELS: Record<MemberRole, string> = {
  owner: "Propietario",
  admin: "Administrador",
  seller: "Vendedor",
  viewer: "Lector",
};

const RANK: Record<MemberRole, number> = {
  viewer: 1,
  seller: 2,
  admin: 3,
  owner: 4,
};

export function isMemberRole(v: unknown): v is MemberRole {
  return typeof v === "string" && (MEMBER_ROLES as readonly string[]).includes(v);
}

export function roleRank(role: MemberRole): number {
  return RANK[role];
}

/** ¿El rol alcanza el mínimo exigido? null = sin auth (dev: permite). */
export function hasMinRole(have: MemberRole | null, need: MemberRole): boolean {
  if (have === null) return true;
  return RANK[have] >= RANK[need];
}

/** Features del sistema y rol mínimo para usarlas. Extender aquí. */
export const FEATURE_MIN_ROLE = {
  "dashboard.view": "viewer",
  "crm.view": "viewer",
  "crm.edit": "seller",
  "settings.view": "viewer",
  "settings.edit": "admin",
  "members.view": "viewer",
  "members.edit": "admin",
  "agency.commission.view": "admin",
  "agency.commission.edit": "admin",
  "screens.delete": "owner",
} as const satisfies Record<string, MemberRole>;

export type FeatureKey = keyof typeof FEATURE_MIN_ROLE;

/** ¿El rol puede usar el feature? */
export function canAccessFeature(role: MemberRole | null, feature: FeatureKey): boolean {
  return hasMinRole(role, FEATURE_MIN_ROLE[feature]);
}
