"use client";

import { useState } from "react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { CalendarIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface DateTimePickerProps {
  date: Date | undefined;
  setDate: (date: Date | undefined) => void;
  label: string;
}

export function DateTimePicker({ date, setDate, label }: DateTimePickerProps) {
  const [timeValue, setTimeValue] = useState<string>(
    date ? format(date, "HH:mm") : "00:00"
  );

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const handleDateSelect = (selectedDate: Date | undefined) => {
    if (selectedDate) {
      const [hours, minutes] = timeValue.split(":").map(Number);
      selectedDate.setHours(hours, minutes);
      setDate(selectedDate);
    } else {
      setDate(undefined);
    }
  };

  const handleTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newTime = e.target.value;
    setTimeValue(newTime);
    if (date) {
      const [hours, minutes] = newTime.split(":").map(Number);
      const newDate = new Date(date);
      newDate.setHours(hours, minutes);
      setDate(newDate);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <span className="text-[10px] text-muted-foreground">{timezone}</span>
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              "w-full justify-start text-left font-normal",
              !date && "text-muted-foreground"
            )}
          >
            <CalendarIcon className="mr-2 h-4 w-4" />
            {date ? format(date, "PPP 'at' HH:mm") : "Pick a date"}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0 z-[200]" align="center" side="bottom" sideOffset={8} collisionPadding={40}>
          <Calendar
            mode="single"
            selected={date}
            onSelect={handleDateSelect}
            initialFocus
          />
          <div className="border-t p-3">
            <Label className="text-xs text-muted-foreground">Time</Label>
            <Input
              type="time"
              value={timeValue}
              onChange={handleTimeChange}
              className="mt-1"
            />
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
