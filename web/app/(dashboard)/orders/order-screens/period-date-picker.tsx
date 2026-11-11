"use client";

import { useState } from "react";
import { CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "cn";
import { es } from "react-day-picker/locale";
import { formatDate, parseISODate, toISODateLocal } from "@/lib/format";

/** Selector de día del periodo (Inicio/Fin). Mismo en nueva orden y edición. */
export function PeriodDatePicker({
  label,
  value,
  onChange,
  disabled,
  disabledDays,
  pickerLabel,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  disabledDays?: (date: Date) => boolean;
  pickerLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = parseISODate(value);

  return (
    <div className="form-field">
      {label}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              aria-label={pickerLabel}
              className={cn(
                "h-9 w-full justify-start bg-background px-2.5 text-sm font-normal",
                !selected && "text-muted-foreground",
              )}
            >
              <CalendarIcon aria-hidden />
              {selected ? formatDate(value) : "Elegir…"}
            </Button>
          }
        />
        <PopoverContent align="start" className="w-auto p-0">
          <Calendar
            mode="single"
            locale={es}
            selected={selected}
            disabled={disabledDays}
            onSelect={(d) => {
              if (d) {
                onChange(toISODateLocal(d));
                setOpen(false);
              }
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
