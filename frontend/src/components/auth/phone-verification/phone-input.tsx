"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, Phone } from "lucide-react";
import { PhoneInput as PhoneInputComponent } from "@/components/ui/phone-input";

function getUserCountryCode(): string {
  if (typeof window === 'undefined') return 'US';
  
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    
    const timezoneToCountry: Record<string, string> = {
      'America/New_York': 'US',
      'America/Chicago': 'US',
      'America/Denver': 'US',
      'America/Los_Angeles': 'US',
      'America/Phoenix': 'US',
      'America/Anchorage': 'US',
      'Pacific/Honolulu': 'US',
      'Europe/London': 'GB',
      'Europe/Paris': 'FR',
      'Europe/Berlin': 'DE',
      'Europe/Rome': 'IT',
      'Europe/Madrid': 'ES',
      'Europe/Amsterdam': 'NL',
      'Europe/Brussels': 'BE',
      'Europe/Vienna': 'AT',
      'Europe/Zurich': 'CH',
      'Europe/Stockholm': 'SE',
      'Europe/Copenhagen': 'DK',
      'Europe/Oslo': 'NO',
      'Europe/Helsinki': 'FI',
      'Europe/Warsaw': 'PL',
      'Europe/Prague': 'CZ',
      'Europe/Budapest': 'HU',
      'Europe/Athens': 'GR',
      'Europe/Lisbon': 'PT',
      'Europe/Dublin': 'IE',
      'Asia/Tokyo': 'JP',
      'Asia/Shanghai': 'CN',
      'Asia/Hong_Kong': 'HK',
      'Asia/Singapore': 'SG',
      'Asia/Seoul': 'KR',
      'Asia/Taipei': 'TW',
      'Asia/Dubai': 'AE',
      'Asia/Kolkata': 'IN',
      'Asia/Bangkok': 'TH',
      'Asia/Jakarta': 'ID',
      'Asia/Manila': 'PH',
      'Australia/Sydney': 'AU',
      'Australia/Melbourne': 'AU',
      'Australia/Brisbane': 'AU',
      'Pacific/Auckland': 'NZ',
      'America/Toronto': 'CA',
      'America/Vancouver': 'CA',
      'America/Mexico_City': 'MX',
      'America/Sao_Paulo': 'BR',
      'America/Argentina/Buenos_Aires': 'AR',
      'America/Santiago': 'CL',
      'America/Bogota': 'CO',
      'America/Lima': 'PE',
      'Africa/Johannesburg': 'ZA',
      'Africa/Cairo': 'EG',
      'Africa/Lagos': 'NG',
      'Africa/Nairobi': 'KE',
    };
    
    if (timezoneToCountry[timezone]) {
      return timezoneToCountry[timezone];
    }
    
    const locale = navigator.language || 'en-US';
    const countryCode = locale.split('-')[1];
    if (countryCode && countryCode.length === 2) {
      return countryCode.toUpperCase();
    }
  } catch (error) {
    console.error('Error detecting country:', error);
  }
  
  return 'US';
}

interface PhoneInputFormProps {
  onSubmit: (phoneNumber: string) => Promise<void>;
  isLoading?: boolean;
  error?: string | null;
}

export function PhoneInput({ onSubmit, isLoading = false, error = null }: PhoneInputFormProps) {
  const t = useTranslations('auth.phoneVerification');
  const [phoneNumber, setPhoneNumber] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [defaultCountry] = useState<string>(() => getUserCountryCode());

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);

    // Basic validation
    if (!phoneNumber.trim()) {
      setLocalError(t('pleaseEnterPhoneNumber'));
      return;
    }

    const phoneRegex = /^\+?[1-9]\d{1,14}$/;
    if (!phoneRegex.test(phoneNumber.replace(/\s/g, ""))) {
      setLocalError(t('pleaseEnterValidPhoneNumber'));
      return;
    }

    await onSubmit(phoneNumber);
  };

  return (
    <Card className="w-full border">
      <CardContent className="pt-6">
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-3">
            <Label htmlFor="phone" className="text-sm font-medium">
              {t('phoneNumber')}
            </Label>
            <PhoneInputComponent
              value={phoneNumber}
              onChange={(value) => setPhoneNumber(value || "")}
              defaultCountry={defaultCountry as any}
              placeholder={t('phoneNumberPlaceholder')}
              disabled={isLoading}
            />
            <p className="text-xs text-muted-foreground">
              {t('sixDigitCodeHint')}
            </p>
          </div>

          {(error || localError) && (
            <Alert variant="destructive" className="py-2">
              <AlertDescription className="text-sm">
                {error || localError}
              </AlertDescription>
            </Alert>
          )}

          <Button 
            type="submit" 
            className="w-full h-11" 
            disabled={isLoading || !phoneNumber.trim()}
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('sendingCode')}
              </>
            ) : (
              <>
                <Phone className="mr-2 h-4 w-4" />
                {t('sendVerificationCode')}
              </>
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}