"use client";

import { useEffect, useRef } from "react";
import type { Map as LeafletMap, Marker as LeafletMarker } from "leaflet";
import { mapPinCheckInsideSvg } from "@/components/map-pin-svg";

const MAPBOX_TOKEN =
  process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "";

export interface PickedPoint {
  lat: number;
  lng: number;
}

/** Selector de punto en mapa (Leaflet + teselas Mapbox): clic o arrastre del
 *  pin. El padre geocodifica en reversa y rellena dirección/distrito/ciudad. */
export function VenueMapPicker({
  lat,
  lng,
  defaultCenter,
  onPick,
  onClear,
}: {
  lat: number | null;
  lng: number | null;
  defaultCenter: { lat: number; lng: number };
  onPick: (p: PickedPoint) => void;
  onClear: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markerRef = useRef<LeafletMarker | null>(null);
  const leafletRef = useRef<{ marker: unknown; divIcon: unknown } | null>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  // Cambios originados en el propio mapa (clic/arrastre): el pin ya está
  // bien, no recentrar.
  const ownMoveRef = useRef(false);

  /** Crea (o mueve) el pin arrastrable. */
  const ensureMarker = (plat: number, plng: number) => {
    const map = mapRef.current;
    const L = leafletRef.current as unknown as typeof import("leaflet") | null;
    if (!map || !L) return;
    if (markerRef.current) {
      markerRef.current.setLatLng([plat, plng]);
      return;
    }
    markerRef.current = L.marker([plat, plng], {
      draggable: true,
      zIndexOffset: 100,
      icon: L.divIcon({
        className: "venue-pick-pin",
        html: `<div style="position:relative;width:0;height:0"><div style="position:absolute;left:0;top:0;transform:translate(-50%,-92%)">${mapPinCheckInsideSvg(32)}</div></div>`,
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      }),
    })
      .addTo(map)
      .on("dragend", () => {
        const pos = (markerRef.current as LeafletMarker).getLatLng();
        ownMoveRef.current = true;
        onPickRef.current({ lat: pos.lat, lng: pos.lng });
      });
  };

  useEffect(() => {
    if (!MAPBOX_TOKEN) return;
    if (!containerRef.current) return;
    const el = containerRef.current;
    let cancelled = false;

    async function init() {
      const L = (await import("leaflet")).default;
      if (cancelled || !containerRef.current) return;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
        markerRef.current = null;
      }
      leafletRef.current = L as unknown as { marker: unknown; divIcon: unknown };
      const hasPoint = lat !== null && lng !== null;
      const map = L.map(el, {
        center: hasPoint ? [lat as number, lng as number] : [defaultCenter.lat, defaultCenter.lng],
        zoom: hasPoint ? 16 : 12,
        zoomControl: false,
      });
      L.control.zoom({ position: "topright" }).addTo(map);
      L.tileLayer(
        `https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/512/{z}/{x}/{y}@2x?access_token=${MAPBOX_TOKEN}`,
        { tileSize: 512, zoomOffset: -1, minZoom: 2, maxZoom: 19, attribution: "© Mapbox © OpenStreetMap" },
      ).addTo(map);

      if (hasPoint) ensureMarker(lat as number, lng as number);
      map.on("click", (e: { latlng: { lat: number; lng: number } }) => {
        ensureMarker(e.latlng.lat, e.latlng.lng);
        ownMoveRef.current = true;
        onPickRef.current({ lat: e.latlng.lat, lng: e.latlng.lng });
      });

      mapRef.current = map;
      const fix = () => {
        if (!cancelled) map.invalidateSize();
      };
      const timers = [setTimeout(fix, 200), setTimeout(fix, 600)];
      const ro = new ResizeObserver(fix);
      ro.observe(el);
      (map as unknown as { __cleanup?: () => void }).__cleanup = () => {
        timers.forEach(clearTimeout);
        ro.disconnect();
      };
    }

    void init();
    return () => {
      cancelled = true;
      const map = mapRef.current;
      if (map) {
        (map as unknown as { __cleanup?: () => void }).__cleanup?.();
        map.remove();
        mapRef.current = null;
        markerRef.current = null;
      }
    };
    // Se monta una vez; el pin se mueve por evento, no por re-init.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sincroniza pin y vista cuando el punto cambia desde fuera
  // (geocodificación directa desde el texto, o limpieza).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (lat === null || lng === null) {
      if (markerRef.current) {
        map.removeLayer(markerRef.current);
        markerRef.current = null;
      }
      return;
    }
    if (ownMoveRef.current) {
      ownMoveRef.current = false;
      return;
    }
    ensureMarker(lat, lng);
    map.setView([lat, lng], Math.max(map.getZoom(), 15));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lng]);

  if (!MAPBOX_TOKEN) {
    return (
      <p className="text-xs text-muted-foreground">
        Mapa no disponible: falta <code>NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN</code>. Igual puedes
        escribir la dirección a mano.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="overflow-hidden rounded-lg ring-1 ring-border">
        <div ref={containerRef} className="screen-map-leaflet h-56 w-full" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground tabular-nums">
          {lat !== null && lng !== null
            ? `${lat.toFixed(6)}, ${lng.toFixed(6)} — clic para mover, arrastra el pin`
            : "Clic en el mapa para marcar el punto"}
        </p>
        {(lat !== null || lng !== null) && (
          <button
            type="button"
            onClick={onClear}
            className="text-[11px] text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Limpiar punto
          </button>
        )}
      </div>
    </div>
  );
}
