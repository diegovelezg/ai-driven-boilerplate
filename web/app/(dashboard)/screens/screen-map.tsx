"use client";

import { useEffect, useRef } from "react";
import type { Map as LeafletMap } from "leaflet";
import { mapPinCheckInsideSvg } from "@/components/map-pin-svg";

const MAPBOX_TOKEN =
  process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "";

/** Mini-mapa de la pantalla (Leaflet + teselas Mapbox, misma mecánica que
 *  MapboxInventoryMap de dooh-agencia-ai: init diferido, invalidateSize tras
 *  montar, pin divIcon + isocrona 250m, cleanup con remove()). */
export function ScreenMap({
  lat,
  lng,
  name,
  code,
}: {
  lat: number | null;
  lng: number | null;
  name: string;
  code: string | null;
}) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<LeafletMap | null>(null);

  const valid =
    lat !== null && lng !== null && Number.isFinite(lat) && Number.isFinite(lng) && MAPBOX_TOKEN !== "";

  useEffect(() => {
    if (!valid) return;
    if (!mapContainerRef.current) return;
    const el = mapContainerRef.current;
    const plat = lat as number;
    const plng = lng as number;
    let isCancelled = false;

    async function initMap() {
      const L = (await import("leaflet")).default;
      if (isCancelled || !mapContainerRef.current) return;

      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }

      const map = L.map(el, { center: [plat, plng], zoom: 15, zoomControl: false });
      L.control.zoom({ position: "topright" }).addTo(map);
      L.tileLayer(
        `https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/512/{z}/{x}/{y}@2x?access_token=${MAPBOX_TOKEN}`,
        { tileSize: 512, zoomOffset: -1, minZoom: 10, maxZoom: 19, attribution: "© Mapbox © OpenStreetMap" },
      ).addTo(map);

      L.circle([plat, plng], {
        radius: 250,
        color: "#16a34a",
        weight: 1.5,
        dashArray: "3, 4",
        fillColor: "#16a34a",
        fillOpacity: 0.12,
        interactive: false,
      }).addTo(map);

      const pinHtml = `
        <div style="position:relative;width:0;height:0">
          <div style="position:absolute;left:0;top:0;transform:translate(-50%,-92%)">${mapPinCheckInsideSvg(30)}</div>
          ${
            code
              ? `<div style="position:absolute;left:0;bottom:26px;transform:translateX(-50%);padding:2px 8px;border-radius:6px;font-size:10px;font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px;z-index:30;background:rgba(255,255,255,0.95);color:#15803d;border:1px solid rgba(22,163,74,0.4);box-shadow:0 4px 6px -1px rgb(0 0 0 / 0.2)">${code}</div>`
              : ""
          }
        </div>
      `;
      L.marker([plat, plng], {
        icon: L.divIcon({ className: "screen-map-pin", html: pinHtml, iconSize: [0, 0], iconAnchor: [0, 0] }),
        zIndexOffset: 100,
      })
        .addTo(map)
        .bindPopup(`<div style="font-weight:600;font-size:13px">${name}</div>`, { closeButton: false });

      mapInstanceRef.current = map;

      // El drawer anima su entrada: recalcular tras montar + ante resize.
      const fix = () => {
        if (!isCancelled) map.invalidateSize();
      };
      const timers = [setTimeout(fix, 200), setTimeout(fix, 600)];
      const ro = new ResizeObserver(fix);
      ro.observe(el);
      (map as unknown as { __cleanup?: () => void }).__cleanup = () => {
        timers.forEach(clearTimeout);
        ro.disconnect();
      };
    }

    void initMap();

    return () => {
      isCancelled = true;
      const map = mapInstanceRef.current;
      if (map) {
        (map as unknown as { __cleanup?: () => void }).__cleanup?.();
        map.remove();
        mapInstanceRef.current = null;
      }
    };
  }, [valid, lat, lng, name, code]);

  if (lat === null || lng === null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return <p className="text-[13px] text-muted-foreground">Sin coordenadas registradas.</p>;
  }
  if (!MAPBOX_TOKEN) {
    return (
      <p className="text-[13px] text-muted-foreground">
        Mapa no disponible: falta <code>NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN</code> en <code>.env.local</code>.
      </p>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg ring-1 ring-border">
      <div ref={mapContainerRef} className="screen-map-leaflet h-48 w-full" />
      <p className="flex items-center justify-between gap-2 bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground tabular-nums">
        <span>
          {lat}, {lng}
        </span>
        <a
          href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`}
          target="_blank"
          rel="noreferrer"
          className="text-primary underline-offset-4 hover:underline"
        >
          Abrir en OpenStreetMap
        </a>
      </p>
    </div>
  );
}
