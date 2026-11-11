"use client";

import { Input } from "@/components/ui/input";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { AppCard } from "@/components/app-card";
import { SubmitButton } from "@/components/buttons";
import { toast } from "@/components/ui/toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { COUNTRIES } from "@/lib/countries";
import { VenueMapPicker, type PickedPoint } from "../venue-map-picker";
import { createScreenSubmitAction, type ScreensState } from "@/lib/screens-actions";
import {
  FIELD_ERR_CLS,
  fieldsFromMessage,
  validateScreenFields,
  type ScreenFieldKey,
} from "../screen-validation";
import { failSubmit, useServerFieldErrors } from "@/components/ui/form-feedback";

const initial: ScreensState = { ok: false, message: "" };

const MAPBOX_TOKEN =
  process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "";

const LIMA_CENTER = { lat: -12.0464, lng: -77.0428 };

export function NuevaPantallaForm({
  suppliers,
  defaultCountry = "PE",
}: {
  suppliers: Array<{ id: string; name: string }>;
  defaultCountry?: string;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState(createScreenSubmitAction, initial);
  const [supplierId, setSupplierId] = useState<string>("__none");
  const [technology, setTechnology] = useState<string>("__none");
  const [modality, setModality] = useState<string>("digital");
  const normalizedDefault = String(defaultCountry ?? "").trim().toUpperCase();
  const [venueCountry, setVenueCountry] = useState<string>(/^[A-Z]{2}$/.test(normalizedDefault) ? normalizedDefault : "PE");
  // Nombre de la ubicación: se compone en el server desde
  // dirección + distrito + ciudad (no se pide aparte).
  const [nameOk, setNameOk] = useState(false);
  const [addressOk, setAddressOk] = useState(false);
  const [screenName, setScreenName] = useState("");
  const [width, setWidth] = useState("");
  const [height, setHeight] = useState("");
  const [widthPx, setWidthPx] = useState("");
  const [heightPx, setHeightPx] = useState("");
  const [price, setPrice] = useState("");
  const [dur, setDur] = useState("");
  const [plays, setPlays] = useState("");
  const [impact, setImpact] = useState("");
  const [venueLat, setVenueLat] = useState<number | null>(null);
  const [venueLng, setVenueLng] = useState<number | null>(null);
  const [venueAddress, setVenueAddress] = useState("");
  const [venueDistrict, setVenueDistrict] = useState("");
  const [venueCity, setVenueCity] = useState("");
  const [geoNote, setGeoNote] = useState<string | null>(null);
  const [geoLoading, setGeoLoading] = useState(false);
  // El nombre de pantalla sugerido solo se aplica si no hay uno propio.
  const screenNameTouched = useRef(false);
  // Marca temporal del último pick en mapa: evita que el eco del pick
  // (dirección rellenada) dispare una geocodificación directa redundante.
  const pickAt = useRef(0);
  const [invalid, setInvalid] = useState<Set<ScreenFieldKey>>(new Set());
  const formRef = useRef<HTMLFormElement>(null);

  const parseM = (raw: string): number | null => {
    const s = raw.trim().replace(",", ".");
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const parsePx = (raw: string): number | null => {
    const s = raw.trim();
    if (!/^\d+$/.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  };
  const wM = parseM(width);
  const hM = parseM(height);
  const wPx = parsePx(widthPx);
  const hPx = parsePx(heightPx);
  const oW = wM ?? wPx;
  const oH = hM ?? hPx;
  const orientation =
    oW !== null && oH !== null
      ? oW > oH
        ? "Horizontal"
        : oW < oH
          ? "Vertical"
          : "Cuadrada"
      : null;

  const bad = (k: ScreenFieldKey) => (invalid.has(k) ? ` ${FIELD_ERR_CLS}` : "");
  const clear = (k: ScreenFieldKey) =>
    invalid.has(k) &&
    setInvalid((p) => {
      const n = new Set(p);
      n.delete(k);
      return n;
    });

  function fail(keys: ScreenFieldKey[], title: string, description: string) {
    setInvalid(new Set(keys));
    toast.add({ title, description, type: "error" });
    const first = keys[0];
    const target =
      first === "venue"
        ? "venue_address"
        : first === "playback"
          ? "duration_sec"
          : first === "impact"
            ? "impact_day"
            : first;
    formRef.current?.querySelector<HTMLElement>(`[name="${target}"]`)?.focus();
  }

  // Punto del mapa → coords + dirección/distrito/ciudad.
  // - Distrito: SIEMPRE de Mapbox (unidad admin más específica:
  //   locality|district|place|neighborhood). Es el dato preciso; heredar el
  //   de una ubicación cercana cruza límites distritales (punto en San
  //   Isidro heredando Jesús María por un venue a 288 m).
  // - Ciudad: place si hay locality (autoridad); si no, la ciudad de la
  //   ubicación cercana (<1 km) como respaldo; si tampoco hay, el propio
  //   distrito (convención fuera de Lima donde coinciden).
  async function handlePick(p: PickedPoint) {
    pickAt.current = Date.now();
    setVenueLat(Number(p.lat.toFixed(6)));
    setVenueLng(Number(p.lng.toFixed(6)));
    setGeoNote(null);
    setGeoLoading(true);
    try {
      const [nearby, geo] = await Promise.all([
        fetch(`/api/venues/nearby?lat=${p.lat}&lng=${p.lng}&radius_m=1000`, { cache: "no-store" })
          .then((r) => r.json() as Promise<{ match?: { name: string; city: string | null; district: string | null; distance_m: number } | null }>)
          .catch(() => null),
        MAPBOX_TOKEN
          ? fetch(
              `https://api.mapbox.com/geocoding/v5/mapbox.places/${p.lng},${p.lat}.json?access_token=${MAPBOX_TOKEN}&language=es&limit=1&types=address,neighborhood,locality,place,district`,
            )
              .then(
                (r) =>
                  r.json() as Promise<{
                    features?: Array<{
                      text?: string;
                      address?: string;
                      place_type?: string[];
                      context?: Array<{ id: string; text: string }>;
                    }>;
                  }>,
              )
              .catch(() => null)
          : Promise.resolve(null),
      ]);
      const m = nearby?.match;
      const f = geo?.features?.[0];
      if (f) {
        const ctx: Record<string, string> = {};
        for (const c of f.context ?? []) ctx[String(c.id).split(".")[0]] = c.text;
        let addr = "";
        if (f.place_type?.includes("address")) {
          const num = typeof f.address === "string" && f.address ? ` ${f.address}` : "";
          addr = `${f.text ?? ""}${num}`.trim();
          if (addr) {
            setVenueAddress(addr);
            setAddressOk(true);
          }
        }
        // Nombre sugerido "Dirección, Distrito" desde el place_name
        // (funciona aunque el feature no sea tipo address).
        const placeName =
          (f as { place_name_es?: string }).place_name_es ??
          (f as { place_name?: string }).place_name ??
          "";
        const suggestion = placeName
          .split(",")
          .slice(0, 2)
          .map((s) => s.trim())
          .filter(Boolean)
          .join(", ");
        if (suggestion) {
          if (!screenNameTouched.current) {
            setScreenName(suggestion);
            setNameOk(true);
          }
        }
        // Distrito: siempre Mapbox (preciso). Ciudad: place si hay locality;
        // si no, respaldo de la ubicación cercana; si tampoco hay, el distrito.
        const district = ctx.locality ?? ctx.district ?? ctx.place ?? ctx.neighborhood ?? "";
        if (district) setVenueDistrict(district);
        if (ctx.locality) {
          if (ctx.place) setVenueCity(ctx.place);
        } else if (m?.city) {
          setVenueCity(m.city);
          const dist = m.distance_m < 1000 ? `${m.distance_m} m` : `${(m.distance_m / 1000).toFixed(1)} km`;
          setGeoNote(`Distrito detectado por mapa; ciudad heredada de ${m.name} (${dist}).`);
        } else if (district) {
          setVenueCity(district);
        }
      }
    } finally {
      setGeoLoading(false);
    }
  }

  // Dirección escrita → punto en el mapa (geocodificación directa con
  // debounce). Se omite el eco inmediato de un pick en mapa.
  useEffect(() => {
    const countryName =
      COUNTRIES.find((c) => c.code === venueCountry)?.name ?? venueCountry;
    const q = [venueAddress.trim(), venueDistrict.trim(), venueCity.trim(), countryName.trim()]
      .filter(Boolean)
      .join(", ");
    if (q.replace(/,/g, "").trim().length < 6 || !MAPBOX_TOKEN) return;
    const h = setTimeout(async () => {
      if (Date.now() - pickAt.current < 1200) return;
      try {
        const cc = /^[A-Z]{2}$/.test(venueCountry) ? `&country=${venueCountry.toLowerCase()}` : "";
        const prox =
          venueLat !== null && venueLng !== null
            ? `&proximity=${venueLng},${venueLat}`
            : "&proximity=-77.0428,-12.0464";
        const r = await fetch(
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?access_token=${MAPBOX_TOKEN}&language=es&limit=1${cc}${prox}`,
        );
        const j = (await r.json()) as {
          features?: Array<{ center?: [number, number]; place_name_es?: string; place_name?: string }>;
        };
        const f = j.features?.[0];
        const c = f?.center;
        if (Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1])) {
          setVenueLat(Number(Number(c[1]).toFixed(6)));
          setVenueLng(Number(Number(c[0]).toFixed(6)));
          setGeoNote("Punto ubicado desde la dirección escrita.");
          if (!screenNameTouched.current) {
            const suggestion = (f?.place_name_es ?? f?.place_name ?? "")
              .split(",")
              .slice(0, 2)
              .map((s) => s.trim())
              .filter(Boolean)
              .join(", ");
            if (suggestion) {
              setScreenName(suggestion);
              setNameOk(true);
            }
          }
        }
      } catch {
        // sin punto: se mantiene el anterior, la dirección igual se guarda
      }
    }, 700);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venueAddress, venueDistrict, venueCity, venueCountry]);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    const fd = new FormData(e.currentTarget);
    const errs = validateScreenFields({
      name: String(fd.get("name") ?? ""),
      venueId: "__new",
      venueAddress: String(fd.get("venue_address") ?? ""),
      width: String(fd.get("width_m") ?? ""),
      height: String(fd.get("height_m") ?? ""),
      widthPx: String(fd.get("width_px") ?? ""),
      heightPx: String(fd.get("height_px") ?? ""),
      price: String(fd.get("price_pen") ?? ""),
      duration: modality === "static" ? "" : String(fd.get("duration_sec") ?? ""),
      plays: modality === "static" ? "" : String(fd.get("plays_per_day") ?? ""),
      impact: String(fd.get("impact_day") ?? ""),
    });
    failSubmit(e, errs, fail);
  }

  // Errores del server action (p. ej. ubicación inexistente, sin permiso): mismo
  // tratamiento, borde + toast en vez de texto inline.
  useServerFieldErrors(state, fieldsFromMessage, setInvalid, "No se pudo crear la pantalla");

  // Éxito: toast + navegación (el toast sobrevive al push en la misma sesión).
  useEffect(() => {
    if (!state.ok) return;
    toast.add({ title: "Pantalla creada", description: state.message, type: "success" });
    router.push("/screens");
  }, [state, router]);

  const countryOk = /^[A-Z]{2}$/.test(venueCountry);
  const canSubmit =
    venueLat !== null &&
    venueLng !== null &&
    nameOk &&
    addressOk &&
    venueDistrict.trim() !== "" &&
    venueCity.trim() !== "" &&
    countryOk &&
    supplierId !== "__none" &&
    (modality === "static" || technology !== "__none") &&
    price.trim() !== "" &&
    width.trim() !== "" &&
    height.trim() !== "" &&
    (modality === "static" || (widthPx.trim() !== "" && heightPx.trim() !== "" && dur.trim() !== "" && plays.trim() !== "")) &&
    impact.trim() !== "";

  return (
    <form ref={formRef} action={action} onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
      <AppCard title="Ubicación">
        <div className="flex flex-col gap-4">
      <div className="form-field">
        Punto en el mapa *
        <input type="hidden" name="venue_latitude" value={venueLat ?? ""} />
        <input type="hidden" name="venue_longitude" value={venueLng ?? ""} />
        <VenueMapPicker
          lat={venueLat}
          lng={venueLng}
          defaultCenter={normalizedDefault === "PE" ? LIMA_CENTER : { lat: 20, lng: 0 }}
          onPick={handlePick}
          onClear={() => {
            setVenueLat(null);
            setVenueLng(null);
            setGeoNote(null);
          }}
        />
        {geoLoading && <p className="text-xs text-muted-foreground">Detectando dirección…</p>}
        {!geoLoading && geoNote !== null ? (
          <p className="text-xs text-muted-foreground">{geoNote}</p>
        ) : (
          !geoLoading && <p className="text-xs text-muted-foreground">Marca dónde está la pantalla.</p>
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="form-field sm:col-span-2">
          Dirección *
          <Input
            name="venue_address"
            maxLength={300}
            placeholder="Av. Pardo 793"
            value={venueAddress}
            aria-invalid={invalid.has("venue")}
            onChange={(e) => {
              setVenueAddress(e.target.value);
              setAddressOk(e.target.value.trim().length > 0);
              clear("venue");
            }}
            className={`${bad("venue")}`}
          />
        </label>
        <div className="grid grid-cols-1 gap-4 sm:col-span-2 sm:grid-cols-3">
          <label className="form-field">
            Distrito *
            <Input
              name="venue_district"
              maxLength={120}
              placeholder="Miraflores"
              value={venueDistrict}
              onChange={(e) => setVenueDistrict(e.target.value)}

            />
          </label>
          <label className="form-field">
            Ciudad *
            <Input
              name="venue_city"
              maxLength={120}
              placeholder="Lima"
              value={venueCity}
              onChange={(e) => setVenueCity(e.target.value)}

            />
          </label>
          <div className="form-field">
            País *
            <input type="hidden" name="venue_country" value={venueCountry === "__none" ? "" : venueCountry} />
            <Select
              value={venueCountry === "" ? "__none" : venueCountry}
              onValueChange={(v) => v && setVenueCountry(v)}
              items={Object.fromEntries(COUNTRIES.map((c) => [c.code, `${c.code} — ${c.name}`]))}
              disabled={pending}
            >
              <SelectTrigger aria-label="País de la ubicación" className="w-full">
                <SelectValue placeholder="Elegir país…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">Sin especificar</SelectItem>
                {COUNTRIES.map((c) => (
                  <SelectItem key={c.code} value={c.code}>{c.code} — {c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
        </div>
      </AppCard>
      <AppCard title="Pantalla" description="Nombre, formato y medidas.">
        <div className="flex flex-col gap-4">
      <label className="form-field">
        Nombre *
        <Input
          name="name"
          maxLength={200}
          placeholder="Pantalla LED — Av. Ejército"
          value={screenName}
          aria-invalid={invalid.has("name")}
          onChange={(e) => {
            setScreenName(e.target.value);
            screenNameTouched.current = e.target.value.trim().length > 0;
            setNameOk(e.target.value.trim().length > 0);
            clear("name");
          }}
          className={`${bad("name")}`}
        />
      </label>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="form-field">
          Tipo *
          <input type="hidden" name="modality" value={modality} />
          <Select
            value={modality}
            onValueChange={(v) => v && setModality(v)}
            items={{ digital: "Digital (video)", static: "Impresa" }}
            disabled={pending}
          >
            <SelectTrigger aria-label="Tipo de pantalla" className="w-full">
              <SelectValue placeholder="Digital (video)" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="digital">Digital (video)</SelectItem>
              <SelectItem value="static">Impresa</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {modality === "digital" && (
          <div className="form-field">
            Tecnología *
            <input type="hidden" name="technology" value={technology} />
            <Select
              value={technology}
              onValueChange={(v) => v && setTechnology(v)}
              items={{ __none: "Sin definir", LED: "LED", LCD: "LCD", OLED: "OLED" }}
              disabled={pending}
            >
              <SelectTrigger aria-label="Tecnología" className="w-full">
                <SelectValue placeholder="Sin definir" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">Sin definir</SelectItem>
                <SelectItem value="LED">LED</SelectItem>
                <SelectItem value="LCD">LCD</SelectItem>
                <SelectItem value="OLED">OLED</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="form-field sm:col-span-2">
          Proveedor *
          <input type="hidden" name="supplier_id" value={supplierId} />
          <Select
            value={supplierId}
            onValueChange={(v) => v && setSupplierId(v)}
            items={Object.fromEntries([
              ["__none", "Sin especificar"],
              ...suppliers.map((s) => [s.id, s.name] as const),
            ])}
            disabled={pending}
          >
            <SelectTrigger aria-label="Proveedor" className="w-full">
              <SelectValue placeholder="Sin especificar" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">Sin especificar</SelectItem>
              {suppliers.map((s) => (
                <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="form-field">
          Ancho (m) *
          <Input
            name="width_m"
            inputMode="decimal"
            placeholder="12"
            value={width}
            aria-invalid={invalid.has("size")}
            onChange={(e) => {
              setWidth(e.target.value.replace(/[^0-9,.]/g, "").slice(0, 8));
              clear("size");
            }}
            className={` tabular-nums${bad("size")}`}
          />
        </label>
        <label className="form-field">
          Alto (m) *
          <Input
            name="height_m"
            inputMode="decimal"
            placeholder="6"
            value={height}
            aria-invalid={invalid.has("size")}
            onChange={(e) => {
              setHeight(e.target.value.replace(/[^0-9,.]/g, "").slice(0, 8));
              clear("size");
            }}
            className={` tabular-nums${bad("size")}`}
          />
        </label>
        {modality === "digital" && (
          <>
          <label className="form-field">
            Ancho (px) *
          <Input
            name="width_px"
            inputMode="numeric"
            placeholder="1920"
            value={widthPx}
            aria-invalid={invalid.has("size")}
            onChange={(e) => {
              setWidthPx(e.target.value.replace(/\D/g, "").slice(0, 6));
              clear("size");
            }}
            className={` tabular-nums${bad("size")}`}
          />
        </label>
        <label className="form-field">
          Alto (px) *
          <Input
            name="height_px"
            inputMode="numeric"
            placeholder="1080"
            value={heightPx}
            aria-invalid={invalid.has("size")}
            onChange={(e) => {
              setHeightPx(e.target.value.replace(/\D/g, "").slice(0, 6));
              clear("size");
            }}
            className={` tabular-nums${bad("size")}`}
          />
        </label>
          </>
        )}
      </div>
      {orientation && modality === "digital" && (
        <p className="text-xs text-muted-foreground">Orientación detectada: {orientation}.</p>
      )}
        </div>
      </AppCard>

      <AppCard title="Precio y pauta" description="Cuánto cuesta y cuántas veces se muestra por día.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="form-field">
          Precio (PEN) *
          <Input
            name="price_pen"
            inputMode="numeric"
            placeholder="1500"
            value={price}
            aria-invalid={invalid.has("price")}
            onChange={(e) => {
              setPrice(e.target.value.replace(/\D/g, "").slice(0, 9));
              clear("price");
            }}
            className={` tabular-nums${bad("price")}`}
          />
        </label>
        {modality === "digital" && (
          <label className="form-field">
            Duración del spot (s) *
            <Input
              name="duration_sec"
              inputMode="numeric"
              placeholder="10"
              value={dur}
              aria-invalid={invalid.has("playback")}
              onChange={(e) => {
                setDur(e.target.value.replace(/\D/g, "").slice(0, 4));
                clear("playback");
              }}
              className={` tabular-nums${bad("playback")}`}
            />
          </label>
        )}
        {modality === "digital" && (
          <label className="form-field">
            Reproducciones / día *
          <Input
            name="plays_per_day"
            inputMode="numeric"
            placeholder="900"
            value={plays}
            aria-invalid={invalid.has("playback")}
            onChange={(e) => {
              setPlays(e.target.value.replace(/\D/g, "").slice(0, 7));
              clear("playback");
            }}
            className={` tabular-nums${bad("playback")}`}
          />
        </label>
        )}
        <label className="form-field">
          Impactos / día *
          <Input
            name="impact_day"
            inputMode="numeric"
            placeholder="150000"
            value={impact}
            aria-invalid={invalid.has("impact")}
            onChange={(e) => {
              setImpact(e.target.value.replace(/\D/g, "").slice(0, 9));
              clear("impact");
            }}
            className={` tabular-nums${bad("impact")}`}
          />
        </label>
      </div>
      </AppCard>

      <div>
        <SubmitButton pending={pending} disabled={!canSubmit} title={!canSubmit ? "Completa todos los campos para continuar" : undefined} pendingLabel="Creando…">
          <Plus aria-hidden />
          Crear pantalla
        </SubmitButton>
      </div>
    </form>
  );
}
