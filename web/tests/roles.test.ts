// Roles por membresía (B2B): jerarquía + gating de features.
// Corre con: npm test (node:test vía tsx, sin BD ni red).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FEATURE_MIN_ROLE,
  MEMBER_ROLE_LABELS,
  canAccessFeature,
  hasMinRole,
  isMemberRole,
  roleRank,
} from "@/lib/roles";

describe("member roles", () => {
  it("jerarquía owner > admin > seller > viewer", () => {
    assert.ok(roleRank("owner") > roleRank("admin"));
    assert.ok(roleRank("admin") > roleRank("seller"));
    assert.ok(roleRank("seller") > roleRank("viewer"));
    assert.equal(isMemberRole("owner"), true);
    assert.equal(isMemberRole("superadmin"), false);
    assert.equal(MEMBER_ROLE_LABELS.admin, "Administrador");
  });

  it("hasMinRole respeta jerarquía (null = dev, permite)", () => {
    assert.equal(hasMinRole("seller", "viewer"), true);
    assert.equal(hasMinRole("seller", "seller"), true);
    assert.equal(hasMinRole("seller", "admin"), false);
    assert.equal(hasMinRole("owner", "admin"), true);
    assert.equal(hasMinRole(null, "owner"), true);
  });

  it("features separadas por rol (base extensible)", () => {
    // Lectura para todos, operación desde seller, config desde admin.
    assert.equal(canAccessFeature("viewer", "crm.view"), true);
    assert.equal(canAccessFeature("viewer", "crm.edit"), false);
    assert.equal(canAccessFeature("seller", "crm.edit"), true);
    assert.equal(canAccessFeature("seller", "settings.edit"), false);
    assert.equal(canAccessFeature("admin", "settings.edit"), true);
    // Miembros: ver todos, editar desde admin.
    assert.equal(canAccessFeature("seller", "members.edit"), false);
    assert.equal(canAccessFeature("admin", "members.edit"), true);
    assert.equal(FEATURE_MIN_ROLE["review.approve"], "seller");
  });
});
