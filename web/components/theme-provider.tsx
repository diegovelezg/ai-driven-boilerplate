"use client";

import * as React from "react";

/** Provider de tema estilo shadcn, sin dependencias ni `<script>`.
 *  Aplica el tema (clase en `<html>`) con DOM + efectos al montar:
 *  cero scripts, cero errores en consola en Next 16. API compatible con
 *  `next-themes` (`attribute`, `defaultTheme`, `enableSystem`, `value`).
 */

type Theme = "light" | "dark" | "system";

interface ThemeContextValue {
  theme: Theme;
  resolvedTheme: "light" | "dark";
  systemTheme: "light" | "dark";
  themes: string[];
  setTheme: (t: Theme) => void;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

const MEDIA = "(prefers-color-scheme: dark)";

function systemTheme(): "light" | "dark" {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return "light";
  return window.matchMedia(MEDIA).matches ? "dark" : "light";
}

function readStored(storageKey: string): Theme | null {
  try {
    const v = window.localStorage.getItem(storageKey);
    return v === "light" || v === "dark" || v === "system" ? v : null;
  } catch {
    return null;
  }
}

function disableTransitions(): () => void {
  const css = document.createElement("style");
  css.appendChild(
    document.createTextNode(
      "*,*::before,*::after{-webkit-transition:none!important;-moz-transition:none!important;-o-transition:none!important;-ms-transition:none!important;transition:none!important}",
    ),
  );
  document.head.appendChild(css);
  return () => {
    // Fuerza reflow para que el estilo aplique antes de retirarlo.
    window.getComputedStyle(document.body);
    window.setTimeout(() => {
      document.head.removeChild(css);
    }, 1);
  };
}

export interface ThemeProviderProps {
  children: React.ReactNode;
  /** default "class". Acepta "class" | "data-*" | lista (igual que next-themes). */
  attribute?: string | string[];
  storageKey?: string;
  defaultTheme?: Theme;
  enableSystem?: boolean;
  enableColorScheme?: boolean;
  disableTransitionOnChange?: boolean;
  /** Mapeo tema → clase/valor (igual que next-themes `value`). */
  value?: Record<string, string>;
  themes?: string[];
  forcedTheme?: string;
}

export function ThemeProvider({
  children,
  attribute = "class",
  storageKey = "theme",
  defaultTheme = "system",
  enableSystem = true,
  enableColorScheme = true,
  disableTransitionOnChange = false,
  value,
  themes = ["light", "dark"],
  forcedTheme,
}: ThemeProviderProps) {
  const [theme, setThemeState] = React.useState<Theme>(() => {
    if (typeof window === "undefined") return defaultTheme;
    return readStored(storageKey) ?? defaultTheme;
  });
  const [sys, setSys] = React.useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "light";
    return systemTheme();
  });

  // Sincroniza con el sistema y entre pestañas.
  React.useEffect(() => {
    const mql = window.matchMedia(MEDIA);
    const onChange = () => setSys(mql.matches ? "dark" : "light");
    onChange();
    mql.addEventListener("change", onChange);
    const onStorage = (e: StorageEvent) => {
      if (e.key === storageKey) setThemeState(readStored(storageKey) ?? defaultTheme);
    };
    window.addEventListener("storage", onStorage);
    return () => {
      mql.removeEventListener("change", onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, [storageKey, defaultTheme]);

  const resolved: "light" | "dark" =
    forcedTheme === "light" || forcedTheme === "dark"
      ? forcedTheme
      : theme === "system" && enableSystem
        ? sys
        : theme === "system"
          ? "light"
          : theme;

  // Aplica el tema al <html>. Sin `<script>`: solo DOM + efectos.
  React.useEffect(() => {
    const restore = disableTransitionOnChange ? disableTransitions() : undefined;
    const el = document.documentElement;
    const mapped = value?.[resolved] ?? resolved;
    const all = value ? Object.values(value) : themes;
    const applyAttr = (attr: string) => {
      if (attr === "class") {
        el.classList.remove(...all);
        if (mapped) el.classList.add(mapped);
      } else if (attr.startsWith("data-")) {
        if (mapped) el.setAttribute(attr, mapped);
        else el.removeAttribute(attr);
      } else {
        el.setAttribute(attr, mapped);
      }
    };
    if (Array.isArray(attribute)) attribute.forEach(applyAttr);
    else applyAttr(attribute);
    if (enableColorScheme) el.style.colorScheme = resolved;
    restore?.();
  }, [resolved, attribute, themes, value, enableColorScheme, disableTransitionOnChange]);

  const setTheme = React.useCallback(
    (t: Theme) => {
      setThemeState(t);
      try {
        window.localStorage.setItem(storageKey, t);
      } catch {
        // Almacenamiento no disponible: el tema vive solo en memoria.
      }
    },
    [storageKey],
  );

  const ctx = React.useMemo<ThemeContextValue>(
    () => ({
      theme: forcedTheme ? (forcedTheme as Theme) : theme,
      resolvedTheme: resolved,
      systemTheme: sys,
      themes: enableSystem ? [...themes, "system"] : themes,
      setTheme,
    }),
    [theme, resolved, sys, themes, enableSystem, setTheme, forcedTheme],
  );

  return <ThemeContext.Provider value={ctx}>{children}</ThemeContext.Provider>;
}

/** Lee y cambia el tema (lo usa `ModeToggle`). */
export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (!ctx)
    return {
      theme: "system",
      resolvedTheme: "light",
      systemTheme: "light",
      themes: ["light", "dark", "system"],
      setTheme: () => {},
    };
  return ctx;
}
