'use client';

import React, { useState, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import {
  Clock,
  Zap,
  Calendar as CalendarIcon,
  Target,
  Timer,
  Repeat,
  ChevronRight,
  Sparkles,
  Activity,
  Globe,
  Loader2,
  CheckCircle2,
  Settings,
  Info
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { TriggerProvider, ScheduleTriggerConfig } from '../types';
import { AgentSelector } from '@/components/agents/agent-selector';

interface SimplifiedScheduleConfigProps {
  provider: TriggerProvider;
  config: ScheduleTriggerConfig;
  onChange: (config: ScheduleTriggerConfig) => void;
  errors: Record<string, string>;
  agentId: string;
  name: string;
  description: string;
  onNameChange: (name: string) => void;
  onDescriptionChange: (description: string) => void;
  isActive: boolean;
  onActiveChange: (active: boolean) => void;
  selectedAgent?: string;
  onAgentSelect?: (agentId: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave?: (data: { name: string; description: string; config: ScheduleTriggerConfig; is_active: boolean }) => void;
  isEditMode?: boolean;
}

interface SchedulePreset {
  id: string;
  name: string;
  description: string;
  cron: string;
  icon: React.ReactNode;
  popular?: boolean;
}

const QUICK_PRESETS: SchedulePreset[] = [
  // High Frequency
  {
    id: 'every-minute',
    name: 'Every minute',
    description: 'Maximum frequency',
    cron: '* * * * *',
    icon: <Zap className="h-5 w-5" />
  },
  {
    id: 'every-5min',
    name: 'Every 5 minutes',
    description: 'Very frequent checks',
    cron: '*/5 * * * *',
    icon: <Timer className="h-5 w-5" />
  },
  {
    id: 'every-15min',
    name: 'Every 15 minutes',
    description: 'High frequency monitoring',
    cron: '*/15 * * * *',
    icon: <Zap className="h-5 w-5" />
  },
  {
    id: 'every-30min',
    name: 'Every 30 minutes',
    description: 'Regular monitoring',
    cron: '*/30 * * * *',
    icon: <Timer className="h-5 w-5" />
  },
  {
    id: 'hourly',
    name: 'Every hour',
    description: 'Hourly check-ins',
    cron: '0 * * * *',
    icon: <Clock className="h-5 w-5" />
  },

  // Daily Options
  {
    id: 'daily-9am',
    name: 'Daily at 9 AM',
    description: 'Morning routine',
    cron: '0 9 * * *',
    icon: <Target className="h-5 w-5" />
  },
  {
    id: 'daily-12pm',
    name: 'Daily at 12 PM',
    description: 'Noon check',
    cron: '0 12 * * *',
    icon: <Target className="h-5 w-5" />
  },
  {
    id: 'daily-6pm',
    name: 'Daily at 6 PM',
    description: 'Evening routine',
    cron: '0 18 * * *',
    icon: <Target className="h-5 w-5" />
  },
  {
    id: 'twice-daily',
    name: 'Twice daily',
    description: '9 AM and 5 PM',
    cron: '0 9,17 * * *',
    icon: <Repeat className="h-5 w-5" />
  },

  // Weekly Options
  {
    id: 'weekdays-9am',
    name: 'Weekdays at 9 AM',
    description: 'Monday-Friday mornings',
    cron: '0 9 * * 1-5',
    icon: <CalendarIcon className="h-5 w-5" />
  },
  {
    id: 'monday-mornings',
    name: 'Monday mornings',
    description: 'Every Monday at 9 AM',
    cron: '0 9 * * 1',
    icon: <CalendarIcon className="h-5 w-5" />
  },
  {
    id: 'friday-evenings',
    name: 'Friday evenings',
    description: 'Every Friday at 5 PM',
    cron: '0 17 * * 5',
    icon: <CalendarIcon className="h-5 w-5" />
  },
  {
    id: 'weekend-mornings',
    name: 'Weekend mornings',
    description: 'Saturday & Sunday at 10 AM',
    cron: '0 10 * * 0,6',
    icon: <CalendarIcon className="h-5 w-5" />
  },

  // Monthly Options
  {
    id: 'monthly-1st',
    name: 'Monthly on 1st',
    description: 'First day of month at 9 AM',
    cron: '0 9 1 * *',
    icon: <CalendarIcon className="h-5 w-5" />
  },
  {
    id: 'monthly-15th',
    name: 'Monthly on 15th',
    description: 'Mid-month at 9 AM',
    cron: '0 9 15 * *',
    icon: <CalendarIcon className="h-5 w-5" />
  },
  {
    id: 'end-of-month',
    name: 'End of month',
    description: 'Last few days at 9 AM',
    cron: '0 9 28-31 * *',
    icon: <CalendarIcon className="h-5 w-5" />
  }
];

const RECURRING_PRESETS: SchedulePreset[] = [
  {
    id: 'weekdays-9am',
    name: 'Weekdays at 9 AM',
    description: 'Business hours only',
    cron: '0 9 * * 1-5',
    icon: <CalendarIcon className="h-5 w-5" />
  },
  {
    id: 'weekly-monday',
    name: 'Weekly on Monday',
    description: 'Weekly summary',
    cron: '0 9 * * 1',
    icon: <Repeat className="h-5 w-5" />
  },
  {
    id: 'monthly-1st',
    name: 'Monthly on 1st',
    description: 'Monthly reports',
    cron: '0 9 1 * *',
    icon: <CalendarIcon className="h-5 w-5" />
  }
];

const getTimezones = () => {
  const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const baseTimezones = [
    { value: 'UTC', label: 'UTC (Coordinated Universal Time)' },
    { value: 'America/New_York', label: 'Eastern Time (ET)' },
    { value: 'America/Chicago', label: 'Central Time (CT)' },
    { value: 'America/Denver', label: 'Mountain Time (MT)' },
    { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
    { value: 'Europe/London', label: 'Greenwich Mean Time (GMT)' },
    { value: 'Europe/Paris', label: 'Central European Time (CET)' },
    { value: 'Asia/Tokyo', label: 'Japan Standard Time (JST)' },
    { value: 'Asia/Shanghai', label: 'China Standard Time (CST)' },
    { value: 'Australia/Sydney', label: 'Australian Eastern Time (AET)' },
  ];

  // Add user's timezone if not already in the list
  const hasUserTimezone = baseTimezones.some(tz => tz.value === userTimezone);
  if (!hasUserTimezone) {
    baseTimezones.unshift({
      value: userTimezone,
      label: `${userTimezone} (Your timezone)`
    });
  }

  return baseTimezones;
};

const TIMEZONES = getTimezones();

const WEEKDAYS = [
  { value: '1', label: 'Monday', short: 'Mon' },
  { value: '2', label: 'Tuesday', short: 'Tue' },
  { value: '3', label: 'Wednesday', short: 'Wed' },
  { value: '4', label: 'Thursday', short: 'Thu' },
  { value: '5', label: 'Friday', short: 'Fri' },
  { value: '6', label: 'Saturday', short: 'Sat' },
  { value: '0', label: 'Sunday', short: 'Sun' },
];

const ProgressStepper = ({ currentStep }: { currentStep: 'setup' | 'schedule' | 'execute' }) => {
  const steps = [
    { id: 'setup', name: 'Setup', icon: <Target className="h-4 w-4" /> },
    { id: 'schedule', name: 'Schedule', icon: <Clock className="h-4 w-4" /> },
    { id: 'execute', name: 'Execute', icon: <Sparkles className="h-4 w-4" /> }
  ];

  const currentIndex = steps.findIndex(s => s.id === currentStep);

  return (
    <div className="px-6 py-3 border-b bg-muted/30">
      <div className="flex items-center space-x-1">
        {steps.map((step, index) => (
          <React.Fragment key={step.id}>
            <div className="flex items-center space-x-2">
              <div className={cn(
                "flex items-center justify-center w-6 h-6 rounded-full text-xs font-medium",
                index <= currentIndex
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground"
              )}>
                {index < currentIndex ? (
                  <CheckCircle2 className="h-3 w-3" />
                ) : (
                  <span>{index + 1}</span>
                )}
              </div>
              <span className={cn(
                "text-sm font-medium",
                index <= currentIndex
                  ? "text-foreground"
                  : "text-muted-foreground"
              )}>
                {step.name}
              </span>
            </div>
            {index < steps.length - 1 && (
              <ChevronRight className="h-4 w-4 text-muted-foreground mx-2" />
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
};

const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => ({
  value: (i + 1).toString(),
  label: (i + 1).toString()
}));

export const SimplifiedScheduleConfig: React.FC<SimplifiedScheduleConfigProps> = ({
  config,
  onChange,
  errors,
  agentId,
  name,
  description,
  onNameChange,
  onDescriptionChange,
  isActive,
  onActiveChange,
  selectedAgent,
  onAgentSelect,
  open,
  onOpenChange,
  onSave,
  isEditMode = false
}) => {
  const [currentStep, setCurrentStep] = useState<'setup' | 'schedule' | 'execute'>('setup');
  const [selectedPreset, setSelectedPreset] = useState<string>('');
  const [timezone, setTimezone] = useState<string>(config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone);

  // Recurring schedule state
  const [scheduleType, setScheduleType] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [selectedHour, setSelectedHour] = useState<string>('9');
  const [selectedMinute, setSelectedMinute] = useState<string>('0');
  const [selectedWeekdays, setSelectedWeekdays] = useState<string[]>(['1', '2', '3', '4', '5']);
  const [selectedMonthDays, setSelectedMonthDays] = useState<string[]>(['1']);

  // One-time schedule state
  const [oneTimeDate, setOneTimeDate] = useState<Date | undefined>(undefined);
  const [oneTimeHour, setOneTimeHour] = useState<string>('9');
  const [oneTimeMinute, setOneTimeMinute] = useState<string>('0');


  // Find matching preset
  useEffect(() => {
    const allPresets = [...QUICK_PRESETS, ...RECURRING_PRESETS];
    const preset = allPresets.find(p => p.cron === config.cron_expression);
    setSelectedPreset(preset?.id || '');
  }, [config.cron_expression]);

  // Update cron when recurring settings change
  // Removed auto-generation to prevent interference with preset selections

  // Update cron when one-time settings change
  useEffect(() => {
    if (!selectedPreset && oneTimeDate) { // Only auto-generate if no preset is selected
      handleOneTimeScheduleChange();
    }
  }, [oneTimeDate, oneTimeHour, oneTimeMinute]);

  // Initialize recurring schedule on component mount if no preset is selected
  useEffect(() => {
    if (!selectedPreset && !config.cron_expression) {
      handleRecurringScheduleChange();
    }
  }, []);

  const handlePresetSelect = (presetId: string) => {
    const allPresets = [...QUICK_PRESETS, ...RECURRING_PRESETS];
    const preset = allPresets.find(p => p.id === presetId);
    if (preset) {
      setSelectedPreset(presetId);
      onChange({
        ...config,
        cron_expression: preset.cron,
        timezone: timezone
      });

      // Auto-generate name if empty
      if (!name) {
        onNameChange(preset.name);
      }
    }
  };

  const handleTimezoneChange = (newTimezone: string) => {
    setTimezone(newTimezone);
    onChange({
      ...config,
      timezone: newTimezone
    });
  };

  const generateCronFromRecurring = () => {
    const minute = selectedMinute || '0';
    const hour = selectedHour || '9';

    switch (scheduleType) {
      case 'daily':
        return `${minute} ${hour} * * *`;
      case 'weekly':
        const weekdays = selectedWeekdays.length > 0 ? selectedWeekdays.join(',') : '1';
        return `${minute} ${hour} * * ${weekdays}`;
      case 'monthly':
        const monthDays = selectedMonthDays.length > 0 ? selectedMonthDays.join(',') : '1';
        return `${minute} ${hour} ${monthDays} * *`;
      default:
        return `${minute} ${hour} * * *`;
    }
  };

  const handleRecurringScheduleChange = () => {
    const cronExpression = generateCronFromRecurring();
    console.log('Generated cron expression:', cronExpression, {
      scheduleType,
      selectedHour,
      selectedMinute,
      selectedWeekdays,
      selectedMonthDays
    });
    onChange({
      ...config,
      cron_expression: cronExpression,
      timezone: timezone
    });
    // Only clear preset if we're generating a different cron than what's currently set
    if (cronExpression !== config.cron_expression) {
      setSelectedPreset(''); // Clear preset selection when using custom recurring
    }
  };

  const handleWeekdayToggle = (weekday: string) => {
    const newWeekdays = selectedWeekdays.includes(weekday)
      ? selectedWeekdays.filter(w => w !== weekday)
      : [...selectedWeekdays, weekday].sort();
    
    // Prevent deselecting all weekdays (must have at least one)
    if (newWeekdays.length > 0) {
      setSelectedWeekdays(newWeekdays);
      setTimeout(() => handleRecurringScheduleChange(), 0);
    }
  };

  const handleMonthDayToggle = (day: string) => {
    const newDays = selectedMonthDays.includes(day)
      ? selectedMonthDays.filter(d => d !== day)
      : [...selectedMonthDays, day].sort((a, b) => parseInt(a) - parseInt(b));
    
    // Prevent deselecting all month days (must have at least one)
    if (newDays.length > 0) {
      setSelectedMonthDays(newDays);
      setTimeout(() => handleRecurringScheduleChange(), 0);
    }
  };

  const generateCronFromOneTime = () => {
    if (!oneTimeDate) return '';

    const minute = oneTimeMinute;
    const hour = oneTimeHour;
    const day = oneTimeDate.getDate();
    const month = oneTimeDate.getMonth() + 1; // JavaScript months are 0-indexed

    return `${minute} ${hour} ${day} ${month} *`;
  };

  const handleOneTimeScheduleChange = () => {
    const cronExpression = generateCronFromOneTime();
    onChange({
      ...config,
      cron_expression: cronExpression,
      timezone: timezone
    });
    setSelectedPreset(''); // Clear preset selection when using one-time
  };

  const handleAgentPromptChange = (prompt: string) => {
    onChange({
      ...config,
      agent_prompt: prompt
    });
  };

  const renderContent = () => (
    <div className="flex flex-col h-full max-h-[90vh]">
      <div className="shrink-0 px-6 py-4 border-b">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">{isEditMode ? 'Edit Scheduled Task' : 'Create Scheduled Task'}</h2>
        </div>
      </div>
      <ProgressStepper currentStep={currentStep} />
      <div className="flex-1 overflow-hidden">
        <div className="h-full flex flex-col">
          {currentStep === 'setup' && (
            <div className="h-full flex flex-col">
              <div className="p-6 border-b flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10">
                    <Target className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <h2 className="text-xl font-semibold">Task Setup</h2>
                    <p className="text-sm text-muted-foreground">
                      Configure basic information for your automated task
                    </p>
                  </div>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-6" style={{ maxHeight: 'calc(90vh - 200px)' }}>
                <div className="max-w-2xl mx-auto space-y-6">
                  {/* Agent Selection */}
                  {onAgentSelect && (
                    <div className="border rounded-lg p-4 space-y-4">
                      <div>
                        <h3 className="font-medium mb-1">Agent Selection</h3>
                        <p className="text-sm text-muted-foreground">Choose which agent will handle this task</p>
                      </div>
                      <div className="space-y-2">
                        <Label>Agent</Label>
                        <AgentSelector
                          selectedAgentId={selectedAgent}
                          onAgentSelect={onAgentSelect}
                          placeholder="Choose an agent to handle this task"
                          showCreateOption={true}
                        />
                      </div>
                    </div>
                  )}

                  {/* Basic Info */}
                  <div className="border rounded-lg p-4 space-y-4">
                    <div>
                      <h3 className="font-medium mb-1">Task Details</h3>
                      <p className="text-sm text-muted-foreground">Configure basic information about your task</p>
                    </div>
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <Label htmlFor="task-name">Task Name</Label>
                        <Input
                          id="task-name"
                          value={name}
                          onChange={(e) => onNameChange(e.target.value)}
                          placeholder="e.g., Daily report generation"
                          className={cn(errors.name && "border-destructive")}
                        />
                        {errors.name && (
                          <p className="text-sm text-destructive">{errors.name}</p>
                        )}
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="task-description">Description (Optional)</Label>
                        <Textarea
                          id="task-description"
                          value={description}
                          onChange={(e) => onDescriptionChange(e.target.value)}
                          placeholder="Brief description of what this task does"
                          rows={2}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Helpful Tip */}
                  <div className="bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                    <div className="flex items-start gap-3">
                      <div className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-900/30 mt-0.5">
                        <Info className="h-3 w-3 text-blue-600 dark:text-blue-400" />
                      </div>
                      <div className="flex-1">
                        <h4 className="font-medium text-sm text-blue-900 dark:text-blue-100 mb-1">Pro Tip</h4>
                        <p className="text-sm text-blue-700 dark:text-blue-300">
                          Choose a descriptive name that clearly explains what this task will do. This helps you identify and manage your tasks later.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Setup Step Footer */}
              <div className="shrink-0 border-t p-4 bg-background">
                <div className="flex justify-end">
                  <Button
                    onClick={() => setCurrentStep('schedule')}
                    disabled={!name.trim() || (onAgentSelect && !selectedAgent)}
                    size="sm"
                  >
                    Next: Set Schedule & Timing
                    <ChevronRight className="h-3 w-3 ml-2" />
                  </Button>
                </div>
              </div>
            </div>
          )}

          {currentStep === 'schedule' && (
            <div className="h-full flex flex-col">
              <div className="p-6 border-b flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10">
                    <Clock className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <h2 className="text-xl font-semibold">Schedule Configuration</h2>
                    <p className="text-sm text-muted-foreground">
                      Set up when and how often this task should run
                    </p>
                  </div>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-6" style={{ maxHeight: 'calc(90vh - 200px)' }}>
                <div className="max-w-2xl mx-auto space-y-6">
                  {/* Frequency Selection */}
                  <div className="border rounded-lg p-4 space-y-4">
                    <div>
                      <h3 className="font-medium mb-1">Schedule Frequency</h3>
                      <p className="text-sm text-muted-foreground">Choose how often this task should run</p>
                    </div>
                    <Tabs defaultValue="quick" className="w-full">
                      <TabsList className="grid w-full grid-cols-4">
                        <TabsTrigger value="quick">Quick</TabsTrigger>
                        <TabsTrigger value="recurring">Recurring</TabsTrigger>
                        <TabsTrigger value="one-time">One-time</TabsTrigger>
                        <TabsTrigger value="advanced">Advanced</TabsTrigger>
                      </TabsList>

                      <TabsContent value="quick" className="space-y-3">
                        <div className="space-y-2">
                          <Label className="text-sm font-medium">Choose a common schedule</Label>
                          <div className="max-h-64 overflow-y-auto pr-2 space-y-2">
                            {QUICK_PRESETS.map((preset) => (
                              <Button
                                key={preset.id}
                                variant={selectedPreset === preset.id ? "default" : "outline"}
                                size="sm"
                                onClick={() => handlePresetSelect(preset.id)}
                                className="w-full justify-start h-12 p-3"
                              >
                                <div className="flex items-center gap-3 w-full">
                                  <div className="flex-shrink-0">
                                    {preset.icon}
                                  </div>
                                  <div className="flex-1 text-left min-w-0">
                                    <div className="font-medium text-sm">{preset.name}</div>
                                    <div className="text-xs text-muted-foreground truncate">
                                      {preset.description}
                                    </div>
                                  </div>
                                </div>
                              </Button>
                            ))}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            Can't find what you need? Try the "Recurring" tab for custom schedules.
                          </p>
                        </div>
                      </TabsContent>

                      <TabsContent value="recurring" className="space-y-4">
                        <div className="space-y-4">
                          <Label className="text-sm font-medium">Set up recurring schedule</Label>

                          {/* Schedule Type */}
                          <div className="space-y-2">
                            <Label className="text-sm">How often should this run?</Label>
                            <Select value={scheduleType} onValueChange={(value: 'daily' | 'weekly' | 'monthly') => {
                              setScheduleType(value);
                              // Set appropriate defaults for the schedule type
                              if (value === 'weekly' && selectedWeekdays.length === 5) {
                                // If switching to weekly and currently have weekdays selected, set to just Monday
                                setSelectedWeekdays(['1']);
                              } else if (value === 'monthly' && selectedMonthDays.length !== 1) {
                                // If switching to monthly, set to first day of month
                                setSelectedMonthDays(['1']);
                              }
                              setTimeout(() => handleRecurringScheduleChange(), 0);
                            }}>
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="daily">Every day</SelectItem>
                                <SelectItem value="weekly">Specific days of the week</SelectItem>
                                <SelectItem value="monthly">Specific days of the month</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>

                          {/* Time Selection */}
                          <div className="space-y-2">
                            <Label className="text-sm">What time should it run?</Label>
                            <div className="flex gap-2 items-center">
                              <Select value={selectedHour} onValueChange={(value) => {
                                setSelectedHour(value);
                                setTimeout(() => handleRecurringScheduleChange(), 0);
                              }}>
                                <SelectTrigger className="w-20">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {Array.from({ length: 24 }, (_, i) => (
                                    <SelectItem key={i} value={i.toString()}>
                                      {i.toString().padStart(2, '0')}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <span className="text-muted-foreground">:</span>
                              <Select value={selectedMinute} onValueChange={(value) => {
                                setSelectedMinute(value);
                                setTimeout(() => handleRecurringScheduleChange(), 0);
                              }}>
                                <SelectTrigger className="w-20">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {['00', '15', '30', '45'].map((minute) => (
                                    <SelectItem key={minute} value={minute}>
                                      {minute}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <span className="text-sm text-muted-foreground ml-2">
                                ({selectedHour.padStart(2, '0')}:{selectedMinute} - 24h format)
                              </span>
                            </div>
                          </div>

                          {/* Weekly - Day Selection */}
                          {scheduleType === 'weekly' && (
                            <div className="space-y-3">
                              <Label className="text-sm">Which days of the week?</Label>
                              <div className="flex gap-1 flex-wrap">
                                {WEEKDAYS.map((day) => (
                                  <Button
                                    key={day.value}
                                    variant={selectedWeekdays.includes(day.value) ? "default" : "outline"}
                                    size="sm"
                                    onClick={() => handleWeekdayToggle(day.value)}
                                    className="h-9 w-14 p-0 text-xs"
                                  >
                                    {day.short}
                                  </Button>
                                ))}
                              </div>
                              <p className="text-xs text-muted-foreground">
                                Click to select/deselect days. Currently selected: {selectedWeekdays.length} day{selectedWeekdays.length !== 1 ? 's' : ''}
                              </p>
                            </div>
                          )}

                          {/* Monthly - Day Selection */}
                          {scheduleType === 'monthly' && (
                            <div className="space-y-3">
                              <Label className="text-sm">Which days of the month?</Label>
                              <div className="grid grid-cols-7 gap-1 max-h-32 overflow-y-auto">
                                {MONTH_DAYS.map((day) => (
                                  <Button
                                    key={day.value}
                                    variant={selectedMonthDays.includes(day.value) ? "default" : "outline"}
                                    size="sm"
                                    onClick={() => handleMonthDayToggle(day.value)}
                                    className="h-8 w-8 p-0 text-xs"
                                  >
                                    {day.label}
                                  </Button>
                                ))}
                              </div>
                              <p className="text-xs text-muted-foreground">
                                Click to select/deselect days. Currently selected: {selectedMonthDays.length} day{selectedMonthDays.length !== 1 ? 's' : ''}
                              </p>
                            </div>
                          )}

                          {/* Preview */}
                          <div className="bg-muted/50 p-4 rounded-lg border">
                            <div className="font-medium text-sm mb-2">Schedule Summary</div>
                            <div className="space-y-2 text-sm">
                              <div className="text-foreground">
                                {scheduleType === 'daily' && `Every day at ${selectedHour.padStart(2, '0')}:${selectedMinute}`}
                                {scheduleType === 'weekly' && selectedWeekdays.length > 0 &&
                                  `Every ${WEEKDAYS.filter(d => selectedWeekdays.includes(d.value)).map(d => d.label).join(', ')} at ${selectedHour.padStart(2, '0')}:${selectedMinute}`
                                }
                                {scheduleType === 'monthly' && selectedMonthDays.length > 0 &&
                                  `On day${selectedMonthDays.length > 1 ? 's' : ''} ${selectedMonthDays.join(', ')} of each month at ${selectedHour.padStart(2, '0')}:${selectedMinute}`
                                }
                              </div>
                              <div className="text-muted-foreground">
                                <strong>Cron:</strong> <code className="bg-background px-1 rounded font-mono text-xs">{generateCronFromRecurring()}</code>
                              </div>
                            </div>
                          </div>
                        </div>
                      </TabsContent>

                      <TabsContent value="one-time" className="space-y-4">
                        <div className="space-y-4">
                          <Label className="text-sm font-medium">Schedule for specific date and time</Label>

                          {/* Date Selection */}
                          <div className="space-y-2">
                            <Label className="text-xs">Date</Label>
                            <Popover>
                              <PopoverTrigger asChild>
                                <Button
                                  variant="outline"
                                  className={cn(
                                    "w-full justify-start text-left font-normal",
                                    !oneTimeDate && "text-muted-foreground"
                                  )}
                                >
                                  <CalendarIcon className="mr-2 h-4 w-4" />
                                  {oneTimeDate ? format(oneTimeDate, "PPP") : <span>Pick a date</span>}
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent className="w-auto p-0" align="start">
                                <Calendar
                                  mode="single"
                                  selected={oneTimeDate}
                                  onSelect={setOneTimeDate}
                                  disabled={(date) => date < new Date()}
                                  initialFocus
                                />
                              </PopoverContent>
                            </Popover>
                          </div>

                          {/* Time Selection */}
                          <div className="space-y-2">
                            <Label className="text-xs">Time</Label>
                            <div className="flex gap-2">
                              <Select value={oneTimeHour} onValueChange={setOneTimeHour}>
                                <SelectTrigger className="w-20">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {Array.from({ length: 24 }, (_, i) => (
                                    <SelectItem key={i} value={i.toString()}>
                                      {i.toString().padStart(2, '0')}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <span className="flex items-center">:</span>
                              <Select value={oneTimeMinute} onValueChange={setOneTimeMinute}>
                                <SelectTrigger className="w-20">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {['00', '15', '30', '45'].map((minute) => (
                                    <SelectItem key={minute} value={minute}>
                                      {minute}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          </div>

                          {/* Preview */}
                          {oneTimeDate && (
                            <div className="bg-muted/50 p-4 rounded-lg border">
                              <div className="font-medium text-sm mb-2">Schedule Summary</div>
                              <div className="space-y-2 text-sm">
                                <div className="text-foreground">
                                  <strong>Scheduled for:</strong> {format(oneTimeDate, "PPP")} at {oneTimeHour.padStart(2, '0')}:{oneTimeMinute}
                                </div>
                                <div className="text-muted-foreground">
                                  <strong>Cron:</strong> <code className="bg-background px-1 rounded font-mono text-xs">{generateCronFromOneTime()}</code>
                                </div>
                              </div>
                            </div>
                          )}

                          <div className="text-xs text-muted-foreground">
                            <strong>Note:</strong> This task will run once at the specified date and time, then be automatically disabled.
                          </div>
                        </div>
                      </TabsContent>

                      <TabsContent value="advanced" className="space-y-4">
                        <div className="space-y-4">
                          <div>
                            <Label className="text-sm font-medium">Custom Cron Expression</Label>
                            <p className="text-xs text-muted-foreground mt-1">
                              For advanced users who need precise control over scheduling
                            </p>
                          </div>

                          <div className="space-y-2">
                            <Label htmlFor="cron">Cron Expression</Label>
                            <Input
                              id="cron"
                              value={config.cron_expression || ''}
                              onChange={(e) => onChange({ ...config, cron_expression: e.target.value })}
                              placeholder="0 9 * * 1-5"
                              className="font-mono"
                            />
                          </div>

                          {/* Cron Format Info */}
                          <div className="bg-muted/50 p-4 rounded-lg border">
                            <div className="font-medium text-sm mb-2">Cron Format</div>
                            <div className="space-y-2 text-sm">
                              <div className="font-mono text-xs bg-background p-2 rounded border">
                                Format: minute hour day month weekday
                              </div>
                              <div className="text-muted-foreground">
                                <div><strong>Example:</strong> <code className="bg-background px-1 rounded">0 9 * * 1-5</code> = Weekdays at 9 AM</div>
                                <div className="mt-1">
                                  Use <code className="bg-background px-1 rounded">*</code> for any value,
                                  <code className="bg-background px-1 rounded">*/5</code> for every 5 units
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </TabsContent>
                    </Tabs>

                    {errors.cron_expression && (
                      <p className="text-sm text-destructive">{errors.cron_expression}</p>
                    )}
                  </div>

                  {/* Timezone Selection */}
                  <div className="border rounded-lg p-4 space-y-4">
                    <div>
                      <h3 className="font-medium mb-1">Timezone</h3>
                      <p className="text-sm text-muted-foreground">Choose the timezone for your schedule</p>
                    </div>
                    <Select value={timezone} onValueChange={handleTimezoneChange}>
                      <SelectTrigger>
                        <SelectValue>
                          <div className="flex items-center gap-2">
                            <Globe className="h-4 w-4" />
                            <span>{TIMEZONES.find(tz => tz.value === timezone)?.label || timezone}</span>
                          </div>
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {TIMEZONES.map((tz) => (
                          <SelectItem key={tz.value} value={tz.value}>
                            {tz.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Helpful Tip */}
                  <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4">
                    <div className="flex items-start gap-3">
                      <div className="flex items-center justify-center w-6 h-6 rounded-full bg-amber-100 dark:bg-amber-900/30 mt-0.5">
                        <Clock className="h-3 w-3 text-amber-600 dark:text-amber-400" />
                      </div>
                      <div className="flex-1">
                        <h4 className="font-medium text-sm text-amber-900 dark:text-amber-100 mb-1">Timezone Matters</h4>
                        <p className="text-sm text-amber-700 dark:text-amber-300">
                          Your schedule will run according to the timezone you select. Make sure it matches your location or preferred time zone.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Schedule Step Footer */}
              <div className="shrink-0 border-t p-4 bg-background">
                <div className="flex justify-between">
                  <Button
                    variant="outline"
                    onClick={() => setCurrentStep('setup')}
                    size="sm"
                  >
                    <ChevronRight className="h-3 w-3 mr-2 rotate-180" />
                    Back to Setup
                  </Button>
                  <Button
                    onClick={() => setCurrentStep('execute')}
                    disabled={!config.cron_expression && !selectedPreset}
                    size="sm"
                  >
                    Next: Choose Execution Method
                    <ChevronRight className="h-3 w-3 ml-2" />
                  </Button>
                </div>
              </div>
            </div>
          )}

          {currentStep === 'execute' && (
            <div className="h-full flex flex-col">
              <div className="p-6 border-b">
                <div className="flex items-center gap-3">
                  <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary/10">
                    <Sparkles className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <h2 className="text-xl font-semibold">Execution Configuration</h2>
                    <p className="text-sm text-muted-foreground">
                      Configure how your task should be executed
                    </p>
                  </div>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-6" style={{ maxHeight: 'calc(90vh - 200px)' }}>
                <div className="max-w-2xl mx-auto space-y-6">

                  {/* Execution Type Selection */}
                  <div className="border rounded-lg p-4 space-y-4">
                    <div>
                      <h3 className="font-medium mb-1">Execution Method</h3>
                      <p className="text-sm text-muted-foreground">Choose how your task should be executed</p>
                    </div>

                    <div className="p-3 border rounded-lg bg-muted/30">
                      <div className="flex items-center space-x-3">
                        <div className="p-1.5 rounded-lg bg-primary/10">
                          <Sparkles className="h-4 w-4 text-primary" />
                        </div>
                        <div className="flex-1">
                          <Label className="font-medium">Agent Instructions</Label>
                          <p className="text-sm text-muted-foreground">
                            Provide instructions for your agent to execute
                          </p>
                        </div>
                      </div>
                    </div>

                  </div>

                  {/* Agent Instructions */}
                  {true && (
                    <div className="border rounded-lg p-4 space-y-4">
                      <div>
                        <h3 className="font-medium mb-1">Agent Instructions</h3>
                        <p className="text-sm text-muted-foreground">Provide specific instructions for your agent</p>
                      </div>
                      <div className="space-y-2">
                        <Textarea
                          value={config.agent_prompt || ''}
                          onChange={(e) => handleAgentPromptChange(e.target.value)}
                          placeholder="Enter prompt here. Be specific about what you want your agent to do when this task runs."
                          rows={4}
                          className={cn(errors.agent_prompt && "border-destructive")}
                        />
                        {errors.agent_prompt && (
                          <p className="text-sm text-destructive">{errors.agent_prompt}</p>
                        )}
                        <p className="text-xs text-muted-foreground">
                            Use <code className="text-xs bg-muted px-1 rounded">{'{{variable_name}}'}</code> to add variables to the prompt
                        </p>
                      </div>
                    </div>
                  )}

                </div>
              </div>

              {/* Execute Step Footer */}
              <div className="shrink-0 border-t p-4 bg-background">
                <div className="flex justify-between">
                  <Button
                    variant="outline"
                    onClick={() => setCurrentStep('schedule')}
                    size="sm"
                  >
                    <ChevronRight className="h-3 w-3 mr-2 rotate-180" />
                    Back to Schedule
                  </Button>
                  <Button
                    onClick={() => {
                      if (onSave) {
                        onSave({
                          name,
                          description,
                          config: {
                            ...config
                          },
                          is_active: isActive
                        });
                      }
                    }}
                    disabled={!config.agent_prompt?.trim()}
                    size="sm"
                  >
                    {isEditMode ? 'Update Scheduled Task' : 'Create Scheduled Task'}
                    <Sparkles className="h-3 w-3 ml-2" />
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  // Always render as dialog
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] p-0 overflow-hidden">
        <VisuallyHidden>
          <DialogTitle>{isEditMode ? 'Edit Scheduled Task' : 'Create Scheduled Task'}</DialogTitle>
        </VisuallyHidden>
        {renderContent()}
      </DialogContent>
    </Dialog>
  );
};
